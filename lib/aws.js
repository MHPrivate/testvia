const { Route53Client, ChangeResourceRecordSetsCommand, GetChangeCommand} = require("@aws-sdk/client-route-53");
const { EC2Client, DescribeNetworkInterfacesCommand} = require("@aws-sdk/client-ec2");
const axios = require('axios').default;

var debug = require('debug')('aws');
var main = require.main.exports;

var inAws = null;
var instanceId = null;
var apiVersion = null;
var e164s = null;

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

process.running.then(async ()=>{
    debug.enabled && debug('AWS Running');

    inAws = main.secrets.bridgePlatform && main.secrets.bridgePlatform.slice(0,3)=='AWS';

    // Retrieve the local instanceId - will be static
    //
    // Will try the non-token mechanism first, and if that fails, will try the newer
    // mechanism.

    if (inAws) {
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
                debug.enabled && debug('AWS instance details could not be retrieved')
                debug.enabled && debug(err)
            }
        }
        debug.enabled && debug("AWS - instanceId:", instanceId);
    }
});

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
    if (apiVersion==1) {
        try{
                const {data} = await axios.get('http://169.254.169.254/latest/meta-data/public-ipv4');
                return data;
        } catch (error) {
                console.log(error);
                return null;
        }
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
                console.log(error);
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
        console.log(error);
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


//In AWS a REDIS-based mechanism will be used to share the list of training DID numbers between all
// bridge server instances running.
// REDIS will maintain two sets (numbers_available and numbers_in_use).  A REDIS key (numbers_loaded) will be set to 1 once data is initialised.
// If we need to reload the list from the database, first reload the scaber process (to pick up the new data from the DB) then 
// just set the key to 0 and data will be reloaded the next time a training number is requested.
async function reserveTrainingDID() {
    // Use the rpscb.pub method to send general REDIS commands.
    var selectedE164 = null;
    main.modules.rpscb.pub.SPOP("numbers_available", (err,res)=> {
        if(res == null) {
            //No data was available - check whether numbers have been initialised
            main.modules.rpscb.pub.GET("numbers_loaded", (err,res)=> {
                if (res == 0) {
                    // Need to initialise the numbers list
                    main.modules.rpscb.pub.SADD.apply(this, ["numbers_loaded"].concat(e164s), (err,res=> {
                        //Now set the loaded flag
                        main.modules.rpscb.pub.SET("numbers_loaded",1);
                        //Now try to retrieve a number again
                        main.modules.rpscb.pub.SPOP("numbers_available", "numbers_in_use", (err,res)=> {
                            selectedE164 = res;
                        })
                    }))
                }
            })
        } else {
            selectedE164 = res;
        }

        //Number retrieved - add it to the numbers_in_use set
        main.modules.rpscb.pub.SADD("numbers_in_use", selectedE164);

        //By here, selectedE164 should either be null (no numbers available) or a valid e164
        return selectedE164;
    })
}

async function releaseTrainingDID ( e164Number ) {
    // Move the number back the the 'available' set.
    main.modules.rpscb.pub.SMOVE("numbers_in_use", "numbers_available", e164Number)
}