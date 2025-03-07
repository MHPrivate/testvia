const { Route53Client, ChangeResourceRecordSetsCommand, GetChangeCommand} = require("@aws-sdk/client-route-53");
const { EC2Client, DescribeNetworkInterfacesCommand} = require("@aws-sdk/client-ec2");
const axios = require('axios').default;
const rpscb = require('./rpscb');

const { promisify } = require("util");

var debug = require('debug')('aws');
var main = require.main.exports;

var inAws = null;
var instanceId = null;
var apiVersion = null;
var e164s = null;

//REDIS will be used to manage the pool of SCAIP training numbers across multiple bridge servers
//Setup async versions of REDIS functions
var delAsync;           //Delete key
var getAsync;           //Get value from key
var setAsync;           //Set value at key
var spopAsync;          //Remove and return one random member from a set
var saddAsync;          //Add one or more items to a set
var smoveAsync;         //Atomic, move value from set1 to set2
var scardAsync;         //Returns cardinality (no of elements) of specified set

//Store REDIS set and key names in variables
const set_numbers_available = "numbers_available";
const set_numbers_in_use = "numbers_in_use";
const key_numbers_loaded_flag = "numbers_loaded"

debug.enabled && debug('Loading AWS');

module.exports = {
    addAWSElasticIP: addAWSElasticIP,
    getPublicIps: getPublicIps,
    getIsAwsEnvironment: getIsAwsEnvironment,
    route53UpdateDNS: updateDNS,
    storeE164s: storeE164s,
    reserveTrainingDID: reserveTrainingDID,
    releaseTrainingDID: releaseTrainingDID,
};

// Add promise to the WAITs array - modelled on the azure.js structure.
// Purpose it to delay this module setup until after rpscb is loaded and ready.
process.running.wait.push(rpscb.ready.then(startupAWS));

async function startupAWS() {
    return new Promise( async (resolve,reject) => {
        debug.enabled && debug('AWS Starting');

        inAws = (main.secrets && main.secrets.bridgePlatform && main.secrets.bridgePlatform.slice(0,3)=='AWS');

        // Retrieve the local instanceId - will be static
        //
        // Will try the non-token mechanism first, and if that fails, will try the newer
        // mechanism.

        if (inAws) {
            debug.enabled && debug('AWS Detected');

            // Setup async versions of REDIS functions
            // Must be done once running, to ensure rpscb is loaded.

            delAsync = promisify(main.modules.rpscb.pub.del).bind(main.modules.rpscb.pub);
            getAsync = promisify(main.modules.rpscb.pub.get).bind(main.modules.rpscb.pub);
            setAsync = promisify(main.modules.rpscb.pub.set).bind(main.modules.rpscb.pub);
            spopAsync = promisify(main.modules.rpscb.pub.spop).bind(main.modules.rpscb.pub);
            saddAsync = promisify(main.modules.rpscb.pub.sadd).bind(main.modules.rpscb.pub);
            smoveAsync = promisify(main.modules.rpscb.pub.smove).bind(main.modules.rpscb.pub);
            scardAsync = promisify(main.modules.rpscb.pub.scard).bind(main.modules.rpscb.pub);

            // Load/Reload E164 data in redis.
            // If data isn't yet loaded (e164_numbers_loaded = null/0)
            // or If loaded and there are no numbers in use - reload (to pick up any changes to the dataset)
            try {
                let numbers_loaded = await getAsync( key_numbers_loaded_flag );
                let qty_numbers_in_use = parseInt(await scardAsync( set_numbers_in_use ));

                //On server startup, if the training numbers are not yet loaded, or no numbers are currently in use, load the list.
                //    The list is reloaded when no numbers are in use to ensure that the list held by REDIS is accurate to the current Nexus DB data.
                if (e164s && (numbers_loaded == "0" || numbers_loaded == null || qty_numbers_in_use == 0)) {
                    //Load/Reset the E164s
                    await redisLoadE164s(e164s);
                }
            } catch (error) {
                debug.enabled && debug("Error handling REDIS E164s:", error);
            }

            //Retrieve the AWS instance-id and store for later.
            //Try both the API v1 and v2, logging which was successful for later API calls.
            try {
                const {data} = await axios.get('http://169.254.169.254/latest/meta-data/instance-id');
                if(data) {
                    instanceId = data;
                    apiVersion = 1;
                }
            } catch (error) {
                debug.enabled && debug("AWS - fetch instaceId method 1 failed - trying method 2");
            }

            var tokenResponse;
            if (!instanceId) {
                try {
                    debug.enabled && debug("AWS - method 2 getting token");
                    tokenResponse = await axios({
                        method: 'PUT',
                        url: 'http://169.254.169.254/latest/api/token',
                        headers: {
                        'X-aws-ec2-metadata-token-ttl-seconds': 10
                        }
                    })
                    // If this request succeeded, API is v2
                    apiVersion = 2;

                    debug.enabled && debug("AWS - method 2 getting id");
                    const instanceIdResponse = await axios({
                        url: 'http://169.254.169.254/latest/meta-data/instance-id',
                        headers: {
                            'X-aws-ec2-metadata-token': tokenResponse.data
                        }
                    })

                    instanceId = instanceIdResponse.data;

                } catch (err) {
                    debug.enabled && debug('AWS instance details could not be retrieved');
                    debug.enabled && debug(err);
                }
            }
            debug.enabled && debug(`AWS - instanceId: ${instanceId} using API v${apiVersion}` );
        }
        debug.enabled && debug('AWS Startup Completed');
        resolve(new Date);
    });
}


function getIsAwsEnvironment() {
    return inAws;
}

// Network-related functions
//
// The returned IP's object will contain ipv4/ipv6, with each being an array 
// as we may have a number of attached IP addresses
async function getPublicIps() {
    if (!inAws) return null;
    let myIps, ipV4=[], ipV6=[];
    if (apiVersion==1) {
        ipV4 = await getPublicIpV4_apiv1();
        ipV6 = await getPublicIpV6_apiv1();
        if (ipV4 || ipV6) {
            myIps = {};
            myIps['v4'] = [ipV4];
            myIps['v6'] = [ipV6];
        }
    } else if (apiVersion==2) {
        //Returns both v4/v6 from the same call
        myIps = await getPublicIps_apiv2();
    }
    return myIps;
}

async function getPublicIpV4_apiv1() {
    try{
            const {data} = await axios.get('http://169.254.169.254/latest/meta-data/public-ipv4');
            return data;
    } catch (error) {
            // The error will most probably be a 404 response, meaning that there are no public IPv4 addresses allocated
            debug.enabled && debug(error);
            return null;
    }
}

async function getPublicIps_apiv2() {
    if (apiVersion==2) {
        try{
            const input = {
                Filters: [ {Name: "attachment.instance-id", Values: [ instanceId ]}
                ]
            };

            const client = new EC2Client({region: main.secrets.AWS.region});
            const command = new DescribeNetworkInterfacesCommand(input);
            const response = await client.send(command);

            let ips={};
            ips['v4'] = [];
            ips['v6'] = [];
            
            response.NetworkInterfaces.forEach((netInt)=>{
                ips['v4'].push( netInt.Association.PublicIp);
                netInt.Ipv6Addresses.forEach((ipV6Addr)=>{
                    ips['v6'].push( ipV6Addr.Ipv6Address)
                })
            })

            return ips;
        } catch (error) {
                debug.enabled && debug(error);
                return null;
        }
    }
}

async function getPublicIpV6_apiv1() {
    // To fetch IPv6s attached, need to iterate through interfaces
    // and query each one for ipV6
    if (!inAws) return null;

    try{
    let pubV6;
    await axios.get('http://169.254.169.254/latest/network/interfaces/macs')
        .then(async (resp) => {
            let interfaceNames = resp.data;
            let interfaces = (interfaceNames || '').split("/");

            for (const interface of interfaces) {
                let ipv6;
                try {
                    let {data} = await axios.get('http://169.254.169.254/latest/network/interfaces/macs/' + interface + '/ipv6s');
                    ipv6 = data;
                } catch (err) {
                    ipv6 = null;
                }
                if (ipv6) {
                    pubV6 = ipv6;
                    break;
                }
            }
        })
        return pubV6;
    } catch (error) {
        // The error will most probably be a 404 response, meaning that there are no public IPv6 addresses allocated
        debug.enabled && debug(error);
        return null;
    }
}

async function addAWSElasticIP (ifaces) {
    if (inAws) {
        // ifaces will be an array, with the contents returned by os.networkInterfaces()
        const ips = await getPublicIps()

        //The returned ips object has two array properties, v4 and v6
        //The input 'ifaces' object may have some of the discovered IP's already present.
        //If not, add them as an 'AWS' interface object.
        if (ips && (ips.v4 || ips.v6)) {
            // There are values in the getPublicIps() results

            // Scan the incoming ifaces, and delete any matching addresses

            // Iterate through the interfaces:
            for (const [key, address_array] of Object.entries(ifaces)) {
                address_array.forEach((address_object) => {
                    let v4Pos = ips.v4.findIndex((addr)=>address_object.address == addr);
                    let v6Pos = ips.v6.findIndex((addr)=>address_object.address == addr);

                    // If the address was found, remove it from the results
                    if (v4Pos > -1) ips.v4.splice(v4Pos,1);                
                    if (v6Pos > -1) ips.v6.splice(v6Pos,1);                
                })
            }

            if (!ifaces.AWS) ifaces.AWS=[];

            // Now create the AWS entry - if there are any elements to add
            ips.v4.forEach((ip_address) => {
                ifaces.AWS.push({
                    address: ip_address,
                    netmask: '255.255.255.255',
                    family: 'IPv4',
                    mac: '',
                    internal: false,
                    cidr: ip_address + '/32'
                });
            });
            ips.v6.forEach((ip_address) => {
                ifaces.AWS.push({
                    address: ip_address,
                    netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
                    family: 'IPv6',
                    mac: '',
                    internal: false,
                    cidr: ip_address + '/128'
                });
            });
        }
    }
    return ifaces;
}

// Route53-related functions
// Input is the result of the MySQL query on the fqdns table
function updateDNS(fqdns, cb) {
    if (!inAws) return null;

    var main = require.main.exports;

    const hostedZoneId = main.secrets.AWS.route53HostedZoneId;
    const credentials = { region: main.secrets.AWS.region };


    var locals = {};
    locals.awsData = {"ChangeBatch": { "Changes":[]}, HostedZoneId: hostedZoneId};
    var client = new Route53Client( credentials );


    fqdns.forEach(function (fqdn, idx, arr) {
        let change = {}
        change.Action = "UPSERT";
        change.ResourceRecordSet = {Name: fqdn.fqdn, ResourceRecords: [{Value:fqdn.value}], TTL: 300, Type: fqdn.type.toUpperCase()};
        this.ChangeBatch.Changes.push(change)
    }, locals.awsData);

    var command = new ChangeResourceRecordSetsCommand(locals.awsData);
    client.send( command, cb );
}

function storeE164s(e164Data) {
    e164s = e164Data;
}


// In AWS a REDIS-based mechanism will be used to share the list of training DID numbers between all
// bridge server instances running.
// REDIS will maintain two sets (numbers_available and numbers_in_use).  A REDIS key (numbers_loaded) will be set to 1 once data is initialised.
// If we need to reload the list from the database, first reload the scaber process (to pick up the new data from the DB) then 
// just set the key to 0 and data will be reloaded the next time a training number is requested.
async function redisLoadE164s( e164Array ) {
    try {
        //Load/Reset the E164s
        debug.enabled && debug("Re/Storing E164 numbers in redis", e164Array);
        await delAsync( set_numbers_available );
        await delAsync( set_numbers_in_use );
        await saddAsync.apply(this,[ set_numbers_available ].concat(e164Array));
        await setAsync( key_numbers_loaded_flag, 1);
    } catch(error) {
        debug.enabled && debug("Error reloading REDIS E164s:", error);
    }
}

async function reserveTrainingDID() {
    // Use the rpscb.pub object to send general REDIS commands.
    let selectedE164 = null;

    // As a belt-and-braces measure, we can check if numbers have previously been loaded
    let numbers_loaded = await getAsync( key_numbers_loaded_flag );
    if (!numbers_loaded && e164s)
        redisLoadE164s( e164s );

    // Pick a random member from the 'numbers_available' set
    // At this stage, there should be numbers loaded.  Failure scenario is if there are no free training numbers
    // which is also possible in the OVH bridge system.
    selectedE164 = await spopAsync(set_numbers_available);
    if (selectedE164) {
        await saddAsync(set_numbers_in_use, selectedE164);
    } else {
        debug.enabled && debug("No Training numbers_available in Redis");
    }
    return selectedE164;
}

function releaseTrainingDID ( e164Number ) {
    // Move the number back the the 'available' set.
    debug.enabled && debug("Redis releasing number:", e164Number);
    smoveAsync(set_numbers_in_use, set_numbers_available, e164Number);
}

