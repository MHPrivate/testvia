const { Route53Client, ChangeResourceRecordSetsCommand, GetChangeCommand} = require("@aws-sdk/client-route-53");
const axios = require('axios').default;
const awsDataUrl = 'http://169.254.169.254/latest/meta-data/';

var debug = require('debug')('aws');
var main = require.main.exports;

var inAws = null;
debug.enabled && debug('Loading AWS');

module.exports = {
    addAWSElasticIP: addAWSElasticIP,
    getPublicIpV4: getPublicIpV4,
    getPublicIpV6: getPublicIpV6,
    getIsAwsEnvironment: getIsAwsEnvironment,
    route53UpdateDNS: updateDNS
};

process.running.then(start);

function start() {
        debug.enabled && debug('Starting AWS');
        inAws = main.secrets.bridgePlatform && main.secrets.bridgePlatform.slice(0,3)=='AWS';
}

function getIsAwsEnvironment() {
    return inAws;
}

// Network-related functions
async function getPublicIpV4() {
    if (!inAws) return null;
    try{
    const {data} = await axios.get(awsDataUrl + 'public-ipv4');
            return data;
    } catch (error) {
            console.log(error);
            return null;
    }
}

async function getPublicIpV6() {
// To fetch IPv6s attached, need to iterate through interfaces
// and query each one for ipV6
    if (!inAws) return null;

    try{
    let pubV6 = null;
    await axios.get(awsDataUrl + '/network/interfaces/macs')
        .then(async (resp) => {
            let interfaceNames = resp.data;
            let interfaces = (interfaceNames || '').split("/");

            for (const interface of interfaces) {
                let ipv6 = null;
                try {
                    let {data} = await axios.get(awsDataUrl + '/network/interfaces/macs/' + interface + '/ipv6s');
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
        // here we will construct a new interface 'AWS' (if not already there) and add the external IP details
        // This will allow existing larc/SLS management to work
        const ipV4 = await getPublicIpV4()
        const ipV6 = await getPublicIpV6()

        if (ipV4 || ipV6) {
            if (!ifaces.AWS) ifaces.AWS=[];
            var foundV4 = false, foundV6 = false;
            for (var network in ifaces.AWS) {
                foundV4 = (!foundV4 && network.address == ipV4);
                foundV6 = (!foundV6 && network.address == ipV6);
            }

            if (ipV4 && !foundV4) ifaces.AWS.push({
                address: ipV4,
                netmask: '255.255.255.255',
                family: 'IPv4',
                mac: '',
                internal: false,
                cidr: ipV4 + '/32'
            });
            if (ipV6 && !foundV6) ifaces.AWS.push({
                address: ipV6,
                netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
                family: 'IPv6',
                mac: '',
                internal: false,
                cidr: ipV6 + '/128'
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


