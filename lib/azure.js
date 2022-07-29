#! /usr/bin/env node-strict
var Agent = require('agentkeepalive'),
    axios = require('axios').default,
    debug = require('debug')('azure'),
    main = require.main.exports,
    msal = require('@azure/msal-node'),
    os = require('os');

module.exports = exports = {
    channelNowipTails: { // channel-statii[1..4] : [new-alarm,new-unseting,new-restore,new-setting]
        '858810000': ['01700980', '01700983', '01700981', '01700082'], // Fire
        '858810001': ['05200080', '05200083', '05200081', '05200082'], // 40 Volt Relay
        '858810002': ['02300080', '02300083', '02300081', '02300002'], // Personal Attack
        '858810003': ['02800080', '02800083', '02800081', '02800002'], // Intruder
        '858810004': ['05700080', '05700083', '05700081', '05700002'], // System Set/Unset
        '858810005': ['01000080', '01000083', '01000081', '01000002'], // Lift
        '858810006': ['01900080', '01900083', '01900081', '01900002'], // Watch
        '858810007': ['01700080', '01700083', '01700081', '01700002'], // Fire Panel Fault
        '858810008': ['05100080', '05100083', '05100081', '05100002'], // Main Power Failure
        '858810009': ['05900080', '05900083', '05900081', '05900002'], // PSTN Line Failure
        '858810010': ['05800080', '05800083', '05800081', '05800002'], // Poll Failure
        '858810011': ['06200080', '06200083', '06200081', '06200002'], // LAN Failure
        '858810012': ['06100080', '06100083', '06100081', '06100002'], // Radio Failure
        '858810013': ['06400080', '06400083', '06400081', '06400002'], // Test Channel
    },
    defaultDevices: {}, // dataSource => device
    eventCodes: undefined, // <protocol>/<callcode>/<linetype> => {_sbr_protocolid_value@,sbr_callcode,sbr_linetype@, _sbr_calleventid_value@,sbr_eventcodeid,sbr_name,sbr_wardenpresence@,statecode@}
    locationCodes: undefined,
    protocols: undefined, // sbr_name => { sbr_name, sbr_protocolid }
    serviceProvider: undefined, // Telecare-guid
    statusNowipTails: [null, '05300007', '06400000'], // status-statii[7..9] : [normal/voltage-good,low-voltage,test-call]
    truncateCalltype: undefined, // sbr_calltype
    truncateEndReason: undefined, // sbr_operatorcallendreason
    truncateSysCallEndReason: undefined, // sbr_systemcallendreason
};

const nullClause = 'operator="null"';

main.cache.cca = main.cache.cca || new msal.ConfidentialClientApplication({
    auth: {
        authority: main.secrets.appello.authority,
        clientId: main.secrets.appello.clientId,
        clientSecret: main.secrets.appello.clientSecret,
    },
});

main.cache.agentkeepalive = main.cache.agentkeepalive || new Agent({
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000, // active socket keepalive for 60 seconds
    freeSocketTimeout: 30000, // free socket keepalive for 30 seconds
});

function hrMs(hr) {
    return Math.round(hr[0] * 1000 + hr[1] / 1000000);
}

function acquireToken() {
    return main.cache.cca.acquireTokenByClientCredential({
        azureRegion: main.secrets.appello.azureRegion || null,
        scopes: main.secrets.appello.scopes.map(function (scope, idx, arr) {
            return main.secrets.appello.azureBaseUrl + scope;
        }),
        skipCache: false,
    });
}

// startup actions
process.running.wait.push(process.running.then(function azureStartup() {
    var context = {};

    var hr = process.hrtime();
    return acquireToken().then(function (res) { // azureStartup - accessToken
        var ms = hrMs(process.hrtime(hr));
        !context.accessTokenMs ? context.accessTokenMs = [ms] : context.accessTokenMs.unshift(ms);
        debug('accessToken:', context.accessTokenMs[0] + 'ms', 'azureStartup');
        context.accessToken = res.accessToken;

    }).then(function () { // azureStartup - sbr_calltypes
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_calltypes',
            params: {
                $select: 'sbr_name,sbr_calltypeid',
                $filter: `statecode eq 0 and sbr_name eq 'AutoAnsweredNormal'`,
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_calltype">
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_calltypeid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //                <condition attribute="sbr_name" operator="eq" value="AutoAnsweredNormal"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            }
        });

    }).then(function (res) { // azureStartup - sbr_calltypes
        context.truncateCalltypeMs = hrMs(process.hrtime(hr));
        exports.truncateCalltype = res.data.value[0];
        debug('sbr_calltypes:', res.data.value.length, 'item(s)', context.truncateCalltypeMs + 'ms');

    }).then(function () { // azureStartup - sbr_devices
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_devices',
            params: {
                fetchXml: `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_device">
                            <all-attributes/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <condition attribute="sbr_devicenumber" operator="eq" value="-2"/>
                            </filter>
                            <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="outer" visible="false">
                                <all-attributes/>
                                <filter type="and">
                                    <condition attribute="statecode" operator="eq" value="0"/>
                                </filter>
                            </link-entity>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // azureStartup - sbr_devices
        context.defaultDeviceMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (device, idx, arr) { // sbr_callcode, sbr_name, sbr_eventcodeid, S.sbr_name
            exports.defaultDevices[device['_sbr_datasourceid_value@OData.Community.Display.V1.FormattedValue'] || null] = device;
        });
        debug('sbr_devices:', res.data.value.length, 'item(s)', context.defaultDeviceMs + 'ms');

    }).then(function () { // azureStartup - sbr_eventcodes
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_eventcodes',
            params: {
                $select: 'sbr_callcode,_sbr_calleventid_value,sbr_linetype,sbr_name,sbr_name,_sbr_protocolid_value,sbr_wardenpresence',
                //$filter: `statecode eq 0 and _sbr_calleventid_value ne null`,
                $filter: `statecode eq 0`,
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_eventcode">
                //            <attribute name="sbr_callcode"/>
                //            <attribute name="sbr_calleventid"/>
                //            <attribute name="sbr_linetype"/>
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_protocolid"/>
                //            <attribute name="sbr_wardenpresence"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //                <!--<condition attribute="sbr_calleventid" operator="not-null"/>-->
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // azureStartup - sbr_eventcodes
        context.eventCodesMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (row, idx, arr) { // sbr_callcode, sbr_name, sbr_eventcodeid, S.sbr_name
            this[[
                row['_sbr_protocolid_value@OData.Community.Display.V1.FormattedValue'],
                row.sbr_callcode,
                row['sbr_linetype@OData.Community.Display.V1.FormattedValue'],
            ].join('/')] = row;
        }, exports.eventCodes = {});
        debug('sbr_eventcodes:', Object.keys(exports.eventCodes).length, 'item(s)', context.eventCodesMs + 'ms');

    }).then(function () { // azureStartup - sbr_operatorcallendreasons
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_operatorcallendreasons',
            params: {
                $select: 'sbr_name,sbr_operatorcallendreasonid',
                $filter: `statecode eq 0 and sbr_name eq 'Auto Answer (Success)'`,
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_operatorcallendreason">
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_operatorcallendreasonid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //                <condition attribute="sbr_name" operator="eq" value="Auto Answer (Success)"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            }
        });

    }).then(function (res) { // azureStartup - sbr_operatorcallendreasons
        context.truncateEndReasonMs = hrMs(process.hrtime(hr));
        exports.truncateEndReason = res.data.value[0];
        debug('sbr_operatorcallendreasons:', res.data.value.length, 'item(s)', context.truncateEndReasonMs + 'ms');

    }).then(function () { // azureStartup - sbr_protocollocationcodes
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_protocollocationcodes',
            params: {
                $select: 'sbr_callcode,sbr_name,_sbr_protocolid_value',
                $filter: `statecode eq 0`
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_protocollocationcode">
                //            <attribute name="sbr_callcode"/>
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_protocolid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // azureStartup - sbr_protocollocationcodess
        context.locationCodesMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (row, idx, arr) { // sbr_callcode, sbr_name, sbr_eventcodeid, S.sbr_name
            this[[
                row['_sbr_protocolid_value@OData.Community.Display.V1.FormattedValue'],
                row.sbr_callcode,
            ].join('/')] = row;
        }, exports.locationCodes = {});
        debug('sbr_protocollocationcodes:', Object.keys(exports.locationCodes).length, 'item(s)', context.locationCodesMs + 'ms');

    }).then(function () { // azureStartup - sbr_protocols
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_protocols',
            params: {
                $select: 'sbr_name,sbr_protocolid',
                $filter: `statecode eq 0`,
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_protocol">
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_protocolid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // azureStartup - sbr_protocols
        context.protocolsMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (row, idx, arr) {
            this[row.sbr_name] = row;
        }, exports.protocols = {});
        debug('sbr_protocols:', Object.keys(exports.protocols).length, 'item(s)', context.protocolsMs + 'ms');

    }).then(function () { // azureStartup - sbr_serviceproviders
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_serviceproviders',
            params: {
                $select: 'sbr_name,sbr_serviceproviderid',
                $filter: `statecode eq 0 and sbr_name eq 'Telecare'`
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_serviceprovider">
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_serviceproviderid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //                <condition attribute="sbr_name" operator="eq" value="Telecare"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            }
        });

    }).then(function (res) { // azureStartup - sbr_serviceproviders
        context.serviceProviderMs = hrMs(process.hrtime(hr));
        exports.serviceProvider = res.data.value[0];
        debug('sbr_serviceproviders:', res.data.value.length, 'item(s)', context.serviceProviderMs + 'ms');

    }).then(function () { // azureStartup - sbr_serviceproviders
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_systemcallendreasons',
            params: {
                $select: 'sbr_name,sbr_systemcallendreasonid',
                $filter: `statecode eq 0 and sbr_name eq 'Normal'`
                //fetchXml: `
                //    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                //        <entity name="sbr_systemcallendreason">
                //            <attribute name="sbr_name"/>
                //            <attribute name="sbr_systemcallendreasonid"/>
                //            <filter type="and">
                //                <condition attribute="statecode" operator="eq" value="0"/>
                //                <condition attribute="sbr_name" operator="eq" value="Normal"/>
                //            </filter>
                //        </entity>
                //    </fetch>
                //`.replace(/\r?\n\s*/g, ''),
            }
        });

    }).then(function (res) { // azureStartup - sbr_serviceproviders
        context.systemCallEndReasonMs = hrMs(process.hrtime(hr));
        exports.truncateSysCallEndReason = res.data.value[0];
        debug('sbr_systemcallendreasons:', res.data.value.length, 'item(s)', context.systemCallEndReasonMs + 'ms');

    }).catch(function (err) { // azureStartup
        if (err.response && err.response.data.error)
            debug('atStartup:', JSON.stringify(context.axios), '\n' + err.response.data.error.message);
        else
            debug('atStartup:', JSON.stringify(context.axios), err);

    });
}));

process.on('routingLookup', onRoutingLookup); // session:route
function onRoutingLookup(session, cb) {
    var context = session.context,
        devicenumber,
        lineType = session.communicator.grouped ? 'Grouped' : 'Dispersed',
        payload = session.payload,
        xml;

    var hr = process.hrtime();
    acquireToken().then(function (res) { // onRoutingLookup
        var ms = hrMs(process.hrtime(hr));
        !context.accessTokenMs ? context.accessTokenMs = [ms] : context.accessTokenMs.unshift(ms);
        debug(session.sid, 'accessToken:', context.accessTokenMs[0] + 'ms', 'routingLookup');
        context.accessToken = res.accessToken;

    }).then(function () { // onRoutingLookup
        if (!payload.protocol) {
            context.deviceXml = `
                <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                    <entity name="sbr_device">
                        <attribute name="sbr_commissioningstatus"/>
                        <attribute name="sbr_datasourceid"/>
                        <attribute name="sbr_deviceid"/>
                        <attribute name="sbr_devicenumber"/>
                        <attribute name="sbr_devicerole"/><!-- OptionSet: Dwelling,Communal,SecurityDialler,LoneWorker,DoorEntry,TelehealthHub,SafetyMonitor,EnvironmentMonitor -->
                        <attribute name="sbr_equipmentphone"/>
                        <attribute name="sbr_linetype"/><!-- OptionSet: Grouped,Dispersed,IP -->
                        <attribute name="sbr_name"/>
                        <attribute name="sbr_schemeid"/>
                        <attribute name="sbr_wardendevice"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="sbr_equipmentphone" operator="eq" value="${'+' + payload.e164}"/>
                            <!-- Dispersed -->
                            <condition attribute="sbr_linetype" operator="eq" value="858810001"/>
                        </filter>
                        <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="outer" visible="false">
                            <attribute name="sbr_authorityid"/>
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_schemenumber"/>
                            <attribute name="sbr_wardenprocessing"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                            </filter>
                        </link-entity>
                    </entity>
                </fetch>
            `.replace(/\r?\n\s*/g, '');

        } else if (lineType === 'Grouped') {
            context.deviceXml = `
                <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                    <entity name="sbr_device">
                        <attribute name="sbr_commissioningstatus"/>
                        <attribute name="sbr_datasourceid"/>
                        <attribute name="sbr_deviceid"/>
                        <attribute name="sbr_devicenumber"/>
                        <attribute name="sbr_devicerole"/><!-- OptionSet: Dwelling,Communal,SecurityDialler,LoneWorker,DoorEntry,TelehealthHub,SafetyMonitor,EnvironmentMonitor -->
                        <attribute name="sbr_equipmentphone"/>
                        <attribute name="sbr_linetype"/><!-- OptionSet: Grouped,Dispersed,IP -->
                        <attribute name="sbr_name"/>
                        <attribute name="sbr_schemeid"/>
                        <attribute name="sbr_wardendevice"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <condition attribute="sbr_devicenumber" operator="eq" value="${devicenumber = +payload.unit}"/>
                            <!-- Grouped -->
                            <condition attribute="sbr_linetype" operator="eq" value="858810000"/>
                        </filter>
                        <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="inner" visible="false">
                            <attribute name="sbr_authorityid"/>
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_schemenumber"/>
                            <attribute name="sbr_wardenprocessing"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <condition attribute="sbr_schemenumber" operator="eq" value="${+payload.scheme}"/>
                            </filter>
                        </link-entity>
                    </entity>
                </fetch>
            `.replace(/\r?\n\s*/g, '');
        } else if (lineType === 'Dispersed') {
            context.deviceXml = `
                <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                    <entity name="sbr_device">
                        <attribute name="sbr_commissioningstatus"/>
                        <attribute name="sbr_datasourceid"/>
                        <attribute name="sbr_deviceid"/>
                        <attribute name="sbr_devicenumber"/>
                        <attribute name="sbr_devicerole"/><!-- OptionSet: Dwelling,Communal,SecurityDialler,LoneWorker,DoorEntry,TelehealthHub,SafetyMonitor,EnvironmentMonitor -->
                        <attribute name="sbr_equipmentphone"/>
                        <attribute name="sbr_linetype"/><!-- OptionSet: Grouped,Dispersed,IP -->
                        <attribute name="sbr_name"/>
                        <attribute name="sbr_schemeid"/>
                        <attribute name="sbr_wardendevice"/>
                        <filter type="and">
                            <condition attribute="statecode" operator="eq" value="0"/>
                            <filter type="or">
                                <condition attribute="sbr_devicenumber" operator="eq" value="${devicenumber = +payload.originUser}"/>
                                <condition attribute="sbr_equipmentphone" operator="eq" value="${'+' + payload.e164}"/>
                            </filter>
                            <!-- Dispersed -->
                            <condition attribute="sbr_linetype" operator="eq" value="858810001"/>
                        </filter>
                        <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="outer" visible="false">
                            <attribute name="sbr_authorityid"/>
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_schemenumber"/>
                            <attribute name="sbr_wardenprocessing"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                            </filter>
                        </link-entity>
                    </entity>
                </fetch>
            `.replace(/\r?\n\s*/g, '');
        }
        hr = process.hrtime();
        return context.deviceXml && axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_devices',
            params: {
                fetchXml: xml = context.deviceXml,
            },
        });

    }).then(function (res) { // onRoutingLookup
        context.deviceMs = hrMs(process.hrtime(hr));
        var dataSource = context.dataSource || payload.dataSource || undefined;
        var cliDevices = (context.devices = res.data.value).filter(function (device, idx, arr) {
            if (device['_sbr_datasourceid_value@OData.Community.Display.V1.FormattedValue'] !== dataSource) // discard any with mis-matched dataSource
                return false;

            if (device['sbr_devicenumber'] !== devicenumber) // unmatched devicenumber, therefore must match the CLI
                return true;

            context.device = device; // match on devicenumber takes precedence
        });
        if (!context.device)
            context.device = cliDevices.length === 1 ? cliDevices[0] : (exports.defaultDevices[dataSource] || exports.defaultDevices[null]);
        debug(session.sid, 'device:', res.data.value.length, 'item(s)', context.deviceMs + 'ms', JSON.stringify(context.device));

    }).then(function () { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_callevents',
            params: {
                fetchXml: xml = context.calleventidsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_callevent">
                            <attribute name="sbr_calleventid"/>
                            <attribute name="sbr_name"/>
                            <link-entity link-type="inner" name="sbr_sbr_device_sbr_callevent" from="sbr_calleventid" to="sbr_calleventid">
                                <!-- many-to-many joins cannot contribute attributes -->
                                <filter type="and">
                                    <!-- deviceID ${context.device.sbr_devicenumber} -->
                                    <condition attribute="sbr_deviceid" operator="eq" value="${context.device.sbr_deviceid}"/>
                                </filter>
                            </link-entity>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.calleventidsMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (row, idx, arr) {
            this[row.sbr_calleventid] = row;
        }, context.calleventids = {});
        debug(session.sid, 'calleventids:', context.calleventidsMs + 'ms', JSON.stringify(context.calleventids));

    }).then(function () { // onRoutingLookup
        context.locationKey = [
            payload.protocol,
            payload.location,
        ].join('/');
        context.locationCode = exports.locationCodes[context.locationKey] || {};

    }).then(function () { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.eventKeys = [];
        context.eventCodes = [];
        (payload.events || [payload.event]).forEach(function (event, idx, arr) {
            var eventCode, eventKey = [
                payload.protocol,
                event || '',
                lineType,
            ].join('/');
            context.eventKeys.push(eventKey);
            context.eventCodes.push(eventCode = exports.eventCodes[eventKey]);
            if (eventCode)
                context.truncate = context.truncate || eventCode._sbr_calleventid_value in context.calleventids; // aka autoAnswer
        });

    }).then(function () { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.authorityClause = context.device['S.sbr_authorityid'] && `operator="eq" value="${context.device['S.sbr_authorityid']}"`;
        context.callCodeClause = payload.event && `operator="eq" value="${payload.event}"`;
        context.deviceRoleClause = context.device['sbr_devicerole'] && `operator="eq" value="${context.device['sbr_devicerole']}"`;
        context.protocolClause = exports.protocols[payload.protocol] && `operator="eq" value="${exports.protocols[payload.protocol].sbr_protocolid}"`;
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_callroutings',
            params: {
                fetchXml: xml = context.callroutingsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_callrouting">
                            <attribute name="sbr_authorityid"/>
                            <attribute name="sbr_callcode"/>
                            <attribute name="sbr_calleventid"/>
                            <attribute name="sbr_callroutingid"/>
                            <attribute name="sbr_calltypeid"/>
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_devicerole"/>
                            <attribute name="sbr_extendedcallcode"/>
                            <attribute name="sbr_platformid"/>
                            <attribute name="sbr_priority"/>
                            <attribute name="sbr_protocolid"/>
                            <order attribute="sbr_priority" descending="false"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <filter type="or">
                                    <!-- authority ${(context.device['S.sbr_authorityid@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g,'_')} -->
                                    <condition attribute="sbr_authorityid" ${context.authorityClause || nullClause}/>
                                    <condition attribute="sbr_authorityid" operator="null"/>
                                </filter>
                                <filter type="or">
                                    <condition attribute="sbr_callcode" ${context.callCodeClause || nullClause}/>
                                    <condition attribute="sbr_callcode" operator="null"/>
                                </filter>
                                <condition attribute="sbr_commissioningstatus" operator="eq" value="${context.device['sbr_commissioningstatus'] || context.device['S.sbr_commissioningstatus']}"/>
                                <filter type="or">
                                    <!-- devicerole ${(context.device['sbr_devicerole@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                                    <condition attribute="sbr_devicerole" ${context.deviceRoleClause || nullClause}/>
                                    <condition attribute="sbr_devicerole" operator="null"/>
                                </filter>
                                <filter type="or">
                                    <!-- protocol ${(payload.protocol || 'NULL').replace(/:/g, '_')} -->
                                    <condition attribute="sbr_protocolid" ${context.protocolClause || nullClause}/>
                                    <condition attribute="sbr_protocolid" operator="null"/>
                                </filter>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.callroutingsMs = hrMs(process.hrtime(hr));
        context.callroutings = res.data.value;
        debug(session.sid, 'callroutings:', context.callroutingsMs + 'ms', JSON.stringify(context.callroutings));

    }).then(function () { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.orClauses = context.callroutings.map(function (row, idx, arr) {
            return `
                <filter type="and">
                    <!-- *** sbr_callcode: ${row.sbr_callcode || null} *** -->
                    <!-- calltype ${(row['_sbr_calltypeid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                    <condition attribute="sbr_calltypeid" ${row._sbr_calltypeid_value ? `operator="eq" value="${row._sbr_calltypeid_value}"` : nullClause}/>
                    <!-- platform ${(row['_sbr_platformid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                    <condition attribute="sbr_platformid" ${row._sbr_platformid_value ? `operator="eq" value="${row._sbr_platformid_value}"` : nullClause}/>
                    <filter type="or">
                        <!-- protocol ${(row['_sbr_protocolid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                        <condition attribute="sbr_protocolid" ${row._sbr_protocolid_value ? `operator="eq" value="${row._sbr_protocolid_value}"` : nullClause}/>
                        <condition attribute="sbr_protocolid" operator="null"/>
                    </filter>
                </filter>
            `.replace(/\r?\n\s*/g, '');
        });
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_routingendpoints',
            params: {
                fetchXml: xml = context.routingendpointsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_routingendpoint">
                            <attribute name="sbr_calltypeid"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_platformid"/>
                            <attribute name="sbr_protocolid"/>
                            <attribute name="sbr_routingaddress"/>
                            <!-- sbr_protocolid desc so more specific rows come later -->
                            <order attribute="sbr_protocolid" descending="false"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <filter type="or">
                                    ${context.orClauses.join('')}
                                </filter>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        context.routingendpointsMs = hrMs(process.hrtime(hr));
        context.routingendpoints = res.data.value;
        context.callroutings.forEach(function (callrouting, idx, arr) {
            //debug(session.sid, `${callrouting.sbr_callcode || null}:`);
            this[callrouting.sbr_callcode = callrouting.sbr_callcode || null] = callrouting;
            context.routingendpoints.forEach(function (routingendpoint, idx, arr) {
                ['_sbr_calltypeid_value', '_sbr_platformid_value', '_sbr_protocolid_value'].every(function (col, idx, arr) {
                    //debug(session.sid, ` ${col}: ${routingendpoint[col]} ${callrouting[col]}`)
                    return (routingendpoint[col] === callrouting[col]) || (col === '_sbr_protocolid_value' && !routingendpoint[col]);
                }) && Object.assign(callrouting, routingendpoint); // merge routingendpoint into the callrouting record
            });
        }, context.callCodes = {});
        debug(session.sid, 'routingendpoints:', context.routingendpointsMs + 'ms', JSON.stringify(context.routingendpoints));

    }).then(function () { // onRoutingLookup
        if (context.truncate) // allow mysql configJson to prevail if present
            return;

        debug(session.sid, 'callCodes:', JSON.stringify(context.callCodes));
        if (!(context.callCode = context.callCodes[payload.event] || {}).sbr_routingaddress)
            context.callCode = context.callCodes['null'] || {};

    }).then(function () { // onRoutingLookup
        if (context.cdr) {
            debug(session.sid, 'onRoutingLookup: discarding CDR')
            context.cdr = undefined; // enable a new CDR following a fresh routing-lookup
        }
        return cb && cb();

    }).catch(function (err) { // onRoutingLookup
        context.err = err;
        if (cb)
            return cb(Object.assign(err, { axios: context.axios }));

        if (err.response && err.response.data.error)
            debug(session.sid, 'onRoutingLookup:', JSON.stringify(context.axios), '\n' + err.response.data.error.message);
        else
            debug(session.sid, 'onRoutingLookup:', JSON.stringify(context.axios), err);

    });
}

process.on('bsiaSpawnCalls', onBsiaSpawnCalls); // session:leave
function onBsiaSpawnCalls(catalogue, communicator, cb) {
    debug(communicator.session.sid, 'bsia: spawnOffspring', JSON.stringify(catalogue)); // [{ account, channels, status }, ...]
    var context = communicator.session.context,
        devicenumber,
        payload = communicator.session.payload,
        xml;
    context.statii = Object.keys(catalogue.map(r => r.channels + r.status).join('').split('').reduce((w, s) => w[s] = w, {}));

    var hr = process.hrtime();
    acquireToken().then(function (res) { // bsiaSpawnCalls
        var ms = hrMs(process.hrtime(hr));
        !context.accessTokenMs ? context.accessTokenMs = [ms] : context.accessTokenMs.unshift(ms);
        debug(communicator.session.sid, 'accessToken:', context.accessTokenMs[0] + 'ms', 'bsiaSpawnCalls');
        context.accessToken = res.accessToken;

    }).then(function () { // bsiaSpawnCalls
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_devices',
            params: {
                fetchXml: xml = context.deviceXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_device">
                            <attribute name="sbr_channel1"/>
                            <attribute name="sbr_channel2"/>
                            <attribute name="sbr_channel3"/>
                            <attribute name="sbr_channel4"/>
                            <attribute name="sbr_channel5"/>
                            <attribute name="sbr_channel6"/>
                            <attribute name="sbr_channel7"/>
                            <attribute name="sbr_channel8"/>
                            <attribute name="sbr_channel9"/>
                            <attribute name="sbr_channel10"/>
                            <attribute name="sbr_channel11"/>
                            <attribute name="sbr_channel12"/>
                            <attribute name="sbr_channel13"/>
                            <attribute name="sbr_channel14"/>
                            <attribute name="sbr_channel15"/>
                            <attribute name="sbr_channel16"/>
                            <attribute name="sbr_channel17"/>
                            <attribute name="sbr_channel18"/>
                            <attribute name="sbr_channel19"/>
                            <attribute name="sbr_channel20"/>
                            <attribute name="sbr_channel21"/>
                            <attribute name="sbr_channel22"/>
                            <attribute name="sbr_channel23"/>
                            <attribute name="sbr_channel24"/>
                            <attribute name="sbr_channel25"/>
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_datasourceid"/>
                            <attribute name="sbr_deviceid"/>
                            <attribute name="sbr_devicenumber"/>
                            <attribute name="sbr_devicerole"/>
                            <attribute name="sbr_equipmentphone"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_linetype"/>
                            <attribute name="sbr_schemeid"/>
                            <attribute name="sbr_wardendevice"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <!-- SecurityDialler -->
                                <condition attribute="sbr_devicerole" operator="eq" value="858810003"/>
                                <filter type="or">
                                    <condition attribute="sbr_devicenumber" operator="eq" value="${devicenumber = payload.originUser}"/>
                                    <condition attribute="sbr_equipmentphone" operator="eq" value="${'+' + payload.e164}"/>
                                </filter>
                                <!-- Dispersed -->
                                <condition attribute="sbr_linetype" operator="eq" value="858810001"/>
                            </filter>
                            <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="outer" visible="false">
                                <attribute name="sbr_authorityid"/>
                                <attribute name="sbr_commissioningstatus"/>
                                <attribute name="sbr_name"/>
                                <attribute name="sbr_schemenumber"/>
                                <attribute name="sbr_wardenprocessing"/>
                                <filter type="and">
                                    <condition attribute="statecode" operator="eq" value="0"/>
                                </filter>
                            </link-entity>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // bsiaSpawnCalls
        context.deviceMs = hrMs(process.hrtime(hr));
        var dataSource = context.dataSource || payload.dataSource || undefined;
        var cliDevices = (context.devices = res.data.value).filter(function (device, idx, arr) {
            if (device['_sbr_datasourceid_value@OData.Community.Display.V1.FormattedValue'] !== dataSource) // discard any with mis-matched dataSource
                return false;

            if (device['sbr_devicenumber'] !== devicenumber) // unmatched devicenumber, therefore must match the CLI
                return true;

            context.device = device; // match on devicenumber takes precedence
        });
        if (!context.device)
            context.device = cliDevices.length === 1 ? cliDevices[0] : (exports.defaultDevices[dataSource] || exports.defaultDevices[null]);
        debug(communicator.session.sid, 'device:', res.data.value.length, 'item(s)', context.deviceMs + 'ms', JSON.stringify(context.device));

    }).then(function () { // bsiaSpawnCalls
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_callevents',
            params: {
                fetchXml: xml = context.calleventidsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_callevent">
                            <attribute name="sbr_calleventid"/>
                            <attribute name="sbr_name"/>
                            <link-entity link-type="inner" name="sbr_sbr_device_sbr_callevent" from="sbr_calleventid" to="sbr_calleventid">
                                <!-- many-to-many joins cannot contribute attributes -->
                                <filter type="and">
                                    <condition attribute="sbr_deviceid" operator="eq" value="${context.device.sbr_deviceid}"/>
                                </filter>
                            </link-entity>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // bsiaSpawnCalls
        context.calleventidsMs = hrMs(process.hrtime(hr));
        res.data.value.forEach(function (row, idx, arr) {
            this[row.sbr_calleventid] = row;
        }, context.calleventids = {});
        debug(communicator.session.sid, 'calleventids:', context.calleventidsMs + 'ms', JSON.stringify(context.calleventids));

    }).then(function () { // bsiaSpawnCalls
        context.authorityClause = context.device['S.sbr_authorityid'] && `operator="eq" value="${context.device['S.sbr_authorityid']}"`;
        context.protocolClause = exports.protocols[payload.protocol] && `operator="eq" value="${exports.protocols[payload.protocol].sbr_protocolid}"`;
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_callroutings',
            params: {
                fetchXml: xml = context.callroutingsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_callrouting">
                            <attribute name="sbr_authorityid"/>
                            <attribute name="sbr_callcode"/>
                            <attribute name="sbr_calleventid"/>
                            <attribute name="sbr_callroutingid"/>
                            <attribute name="sbr_calltypeid"/>
                            <attribute name="sbr_devicerole"/>
                            <attribute name="sbr_extendedcallcode"/>
                            <attribute name="sbr_platformid"/>
                            <attribute name="sbr_priority"/>
                            <attribute name="sbr_protocolid"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <filter type="or">
                                    <!-- authority ${(context.device['S.sbr_authorityid@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                                    <condition attribute="sbr_authorityid" ${context.authorityClause || nullClause}/>
                                    <condition attribute="sbr_authorityid" operator="null"/>
                                </filter>
                                <filter type="or">
                                    <condition attribute="sbr_callcode" operator="in">
                                        ${context.statii.map(s => '<value>' + s + '</value>').join('')}
                                    </condition>
                                    <condition attribute="sbr_callcode" operator="null"/>
                                </filter>
                                <condition attribute="sbr_commissioningstatus" operator="eq" value="${context.device['sbr_commissioningstatus'] || context.device['S.sbr_commissioningstatus']}"/>
                                <filter type="or">
                                    <!-- SecurityDialler -->
                                    <condition attribute="sbr_devicerole" operator="eq" value="858810003"/>
                                    <condition attribute="sbr_devicerole" operator="null"/>
                                </filter>
                                <filter type="or">
                                    <condition attribute="sbr_protocolid" ${context.protocolClause || nullClause}/>
                                    <condition attribute="sbr_protocolid" operator="null"/>
                                </filter>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // bsiaSpawnCalls
        context.callroutingsMs = hrMs(process.hrtime(hr));
        context.callroutings = res.data.value;
        debug(communicator.session.sid, 'callroutings:', context.callroutingsMs + 'ms', JSON.stringify(context.callroutings));

    }).then(function () { // bsiaSpawnCalls
        context.orClauses = context.callroutings.map(function (row, idx, arr) {
            return `
                <filter type="and">
                    <!-- *** sbr_callcode: ${row.sbr_callcode || null} *** -->
                    <!-- calltype ${(row['_sbr_calltypeid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                    <condition attribute="sbr_calltypeid" ${row._sbr_calltypeid_value ? `operator="eq" value="${row._sbr_calltypeid_value}"` : nullClause}/>
                    <!-- platform ${(row['_sbr_platformid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                    <condition attribute="sbr_platformid" ${row._sbr_platformid_value ? `operator="eq" value="${row._sbr_platformid_value}"` : nullClause}/>
                    <filter type="or">
                        <!-- protocol ${(row['_sbr_protocolid_value@OData.Community.Display.V1.FormattedValue'] || 'NULL').replace(/:/g, '_')} -->
                        <condition attribute="sbr_protocolid" ${row._sbr_protocolid_value ? `operator="eq" value="${row._sbr_protocolid_value}"` : nullClause}/>
                        <condition attribute="sbr_protocolid" operator="null"/>
                    </filter>
                </filter>
            `.replace(/\r?\n\s*/g, '');
        });
        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_routingendpoints',
            params: {
                fetchXml: xml = context.routingendpointsXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_routingendpoint">
                            <attribute name="sbr_calltypeid"/>
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_platformid"/>
                            <attribute name="sbr_protocolid"/>
                            <attribute name="sbr_routingaddress"/>
                            <!-- sbr_protocolid desc so more specific rows come later -->
                            <order attribute="sbr_protocolid" descending="false"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <filter type="or">
                                    ${context.orClauses.join('')}
                                </filter>
                            </filter>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // bsiaSpawnCalls
        context.routingendpointsMs = hrMs(process.hrtime(hr));
        context.routingendpoints = res.data.value;
        context.callroutings.forEach(function (callrouting, idx, arr) {
            //debug(communicator.session.sid, `${callrouting.sbr_callcode || null}:`);
            this[callrouting.sbr_callcode = callrouting.sbr_callcode || null] = callrouting;
            context.routingendpoints.forEach(function (routingendpoint, idx, arr) {
                ['_sbr_calltypeid_value', '_sbr_platformid_value', '_sbr_protocolid_value'].every(function (col, idx, arr) {
                    //debug(communicator.session.sid, ` ${col}: ${routingendpoint[col]} ${callrouting[col]}`)
                    return (routingendpoint[col] === callrouting[col]) || (col === '_sbr_protocolid_value' && !routingendpoint[col]);
                }) && Object.assign(callrouting, routingendpoint);
            });
        }, context.callCodes = {});
        debug(communicator.session.sid, 'routingendpoints:', context.routingendpointsMs + 'ms', JSON.stringify(context.routingendpoints));
        debug(communicator.session.sid, 'callCodes:', JSON.stringify(context.callCodes));

    }).then(function () { // bsiaSpawnCalls
        var row, chan, status, tails, eeellpss, callCode, eventKey, eventCode, truncate, children = context.children = [];
        for (row in catalogue) { // array of {account,channels,status} e.g. [{ account: '717273', channels: '65555555', status: '9' }]
            debug(communicator.session.sid, 'row:', row, JSON.stringify(catalogue[row]));
            for (chan = 0; chan < catalogue[row].channels.length; ++chan) { // string of 8, 16 or 24 digits e.g. '65555555'
                status = catalogue[row].channels[chan];
                col = `sbr_channel${+chan + 1}`;
                tails = exports.channelNowipTails[context.device[col]] || []; // channel NOWIPs e.g. ['01700000', null, null, '01700000']
                eeellpss = tails[+status - 1]; // channel's individual nowip-tail

                debug(communicator.session.sid, JSON.stringify({ chan: chan + 1, status: status, tails: tails, col: context.device[col + '@OData.Community.Display.V1.FormattedValue'], eeellpss: eeellpss }));
                if (!(callCode = context.callCodes[status] || {}).sbr_routingaddress)
                    callCode = context.callCodes['null'] || {};
                eventKey = [payload.protocol, status, context.device['sbr_linetype@OData.Community.Display.V1.FormattedValue'] || 'Dispersed'].join('/');
                eventCode = exports.eventCodes[eventKey] || {};
                truncate = context.truncate || eventCode._sbr_calleventid_value in context.calleventids; // aka autoAnswer
                eeellpss && children.push({
                    account: catalogue[0].account,
                    callCode: callCode,
                    channel: '' + (+chan + 1),
                    eventCode: eventCode,
                    eventKey: eventKey, // <protocol>/<callcode>/<linetype>
                    nowip: { event: eeellpss.slice(0, 3), location: eeellpss.slice(3, 5), priority: eeellpss.slice(5, 6), status: eeellpss.slice(6, 8) },
                    truncate: truncate, // aka autoAnswer
                    status: status,
                    text: context.device[col + '@OData.Community.Display.V1.FormattedValue'],
                    value: context.device[col],
                    when: catalogue[row].when,
                });
            }

            status = catalogue[row].status;
            col = 'sbr_channel25';
            eeellpss = exports.statusNowipTails[+status - 7];

            debug(communicator.session.sid, JSON.stringify({ chan: 25, status: status, tails: exports.statusNowipTails, col: context.device[col + '@OData.Community.Display.V1.FormattedValue'], eeellpss: eeellpss }));
            if (!(callCode = context.callCodes[status] || {}).sbr_routingaddress)
                callCode = context.callCodes['null'] || {};
            eventKey = [payload.protocol, status, context.device['sbr_linetype@OData.Community.Display.V1.FormattedValue'] || 'Dispersed'].join('/');
            eventCode = exports.eventCodes[eventKey] || {};
            truncate = context.truncate || eventCode._sbr_calleventid_value in context.calleventids; // aka autoAnswer
            eeellpss && children.push({
                account: catalogue[0].account,
                channel: '' + 25,
                callCode: callCode, // {sbr_callcode,_sbr_calleventid_value@,sbr_callroutingid,sbr_devicerole@,_sbr_platformid_value@,_sbr_protocolid_value@,statecode@,?sbr_name,?sbr_routingaddress,?sbr_routingendpointid}
                eventCode: eventCode, // {_sbr_protocolid_value@,sbr_callcode,sbr_linetype@, _sbr_calleventid_value@,sbr_eventcodeid,sbr_name,sbr_wardenpresence@,statecode@}
                eventKey: eventKey, // <protocol>/<callcode>/<linetype>
                nowip: { event: eeellpss.slice(0, 3), location: eeellpss.slice(3, 5), priority: eeellpss.slice(5, 6), status: eeellpss.slice(6, 8) },
                truncate: truncate, // aka autoAnswer
                status: status,
                text: context.device[col + '@OData.Community.Display.V1.FormattedValue'],
                value: context.device[col],
                when: catalogue[row].when,
            });
        }
        debug(communicator.session.sid, 'children:', JSON.stringify(children));

        for (var child in children) {
            var session = new main.modules.Session(communicator.session.firstEvt, 'null');
            Object.assign(session.context, context, {
                callCode: children[child].callCode, // {callcode from status}
                truncate: children[child].truncate, // aka autoAnswer
            });
            Object.assign(session.payload, payload, {
                bsia: children[child],
                originUser: children[child].account,
                parent: communicator.session,
                event: children[child].status,
                location: children[child].channel,
            });
            Object.defineProperties(session.payload, {
                parent: { enumerable: false },
            });
            session.signal('consume');
        }

    }).then(function () { // bsiaSpawnCalls
        return cb && cb()

    }).catch(function (err) { // bsiaSpawnCalls
        context.err = err;
        if (cb)
            return cb(Object.assign(err, { axios: context.axios }));

        if (err.response && err.response.data.error)
            debug(communicator.session.sid, 'onBsiaSpawnCalls:', JSON.stringify(context.axios), '\n' + err.response.data.error.message);
        else
            debug(communicator.session.sid, 'onBsiaSpawnCalls:', JSON.stringify(context.axios), err);

    });
}

process.on('writeCallData', onWriteCallData); // consumer-nowip-volt:CHANNEL_ANSWER, consumer-simple:activate, session:leave
function onWriteCallData(session, cb) {
    var context = session.context,
        now = new Date,
        payload = session.payload;
    if (context.cdr) { // CDR already written
        debug(session.sid, 'onWriteCallData:', JSON.stringify({ accessToken: !!context.accessToken, cdr: !!context.cdr }));
        return cb && cb();
    }

    context.callCode && Object.assign(context, context.truncate // routingLookup done
        ? {
            callStatus: 858810002, // Closed
            calltypeId: exports.truncateCalltype.sbr_calltypeid,
            endReasonId: exports.truncateEndReason.sbr_operatorcallendreasonid,
            sysCallEndReason: exports.truncateSysCallEndReason.sbr_systemcallendreasonid
        }
        : {
            callStatus: 858810006, // Pre Call
            calltypeId: context.callCode._sbr_calltypeid_value,
            endReasonId: undefined,
            sysCallEndReason: undefined,
        }
    );
    context.protocolId = (exports.protocols[payload.protocol] || exports.protocols['No Protocol']).sbr_protocolid;

    var hr = process.hrtime();
    acquireToken().then(function (res) { // onWriteCallData
        var ms = hrMs(process.hrtime(hr));
        !context.accessTokenMs ? context.accessTokenMs = [ms] : context.accessTokenMs.unshift(ms);
        debug(session.sid, 'accessToken:', context.accessTokenMs[0] + 'ms', 'writeCallData');
        context.accessToken = res.accessToken;

    }).then(function () { // onWriteCallData
        if (payload.protocol) // should already have the relevant device
            return;

        hr = process.hrtime();
        return axios(context.axios = {
            method: 'get',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            httpsAgent: main.cache.keepaliveagent,
            headers: {
                Authorization: 'Bearer ' + context.accessToken,
                Prefer: 'odata.include-annotations=OData.Community.Display.V1.FormattedValue',
            },
            url: 'sbr_devices',
            params: {
                fetchXml: xml = context.deviceXml = `
                    <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
                        <entity name="sbr_device">
                            <attribute name="sbr_commissioningstatus"/>
                            <attribute name="sbr_datasourceid"/>
                            <attribute name="sbr_deviceid"/>
                            <attribute name="sbr_devicenumber"/>
                            <attribute name="sbr_devicerole"/><!-- OptionSet: Dwelling,Communal,SecurityDialler,LoneWorker,DoorEntry,TelehealthHub,SafetyMonitor,EnvironmentMonitor -->
                            <attribute name="sbr_equipmentphone"/>
                            <attribute name="sbr_linetype"/><!-- OptionSet: Grouped,Dispersed,IP -->
                            <attribute name="sbr_name"/>
                            <attribute name="sbr_schemeid"/>
                            <attribute name="sbr_wardendevice"/>
                            <filter type="and">
                                <condition attribute="statecode" operator="eq" value="0"/>
                                <condition attribute="sbr_equipmentphone" operator="eq" value="${'+' + payload.e164}"/>
                            </filter>
                            <link-entity name="sbr_scheme" from="sbr_schemeid" to="sbr_schemeid" alias="S" link-type="outer" visible="false">
                                <attribute name="sbr_authorityid"/>
                                <attribute name="sbr_commissioningstatus"/>
                                <attribute name="sbr_name"/>
                                <attribute name="sbr_schemenumber"/>
                                <attribute name="sbr_wardenprocessing"/>
                                <filter type="and">
                                    <condition attribute="statecode" operator="eq" value="0"/>
                                </filter>
                            </link-entity>
                        </entity>
                    </fetch>
                `.replace(/\r?\n\s*/g, ''),
            },
        });

    }).then(function (res) { // onWriteCallData
        if (context.device || !res) // should already have the relevant device
            return;

        context.deviceMs = hrMs(process.hrtime(hr));
        var dataSource = context.dataSource || payload.dataSource || undefined;
        var cliDevices = (context.devices = res.data.value).filter(function (device, idx, arr) {
            return device['_sbr_datasourceid_value@OData.Community.Display.V1.FormattedValue'] === dataSource; // discard any with mis-matched dataSource
        });
        if (!context.device)
            context.device = cliDevices.length === 1 ? cliDevices[0] : (exports.defaultDevices[dataSource] || exports.defaultDevices[null]);
        debug(session.sid, 'device:', res.data.value.length, 'item(s)', context.deviceMs + 'ms', `${context.device['sbr_name']}(${context.device['sbr_devicenumber']})`);
        context.truncate = true;

    }).then(function () { // onWriteCallData
        if (Array.isArray(payload.bsia)) { // BSIA parent call
            null;
        } else if (payload.bsia) { // BSIA child call
            context.cdr = context.callCode && {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                sbr_callcode: payload.location,
                //sbr_callid: session.evoId,
                sbr_callstarttime: payload.bsia.when,
                sbr_callstarttimelocal: payload.bsia.when,
                sbr_callstatus: context.callStatus, // Pre Call
                sbr_calluuid: session.evoId,
                sbr_cli: '+' + payload.e164,
                sbr_cpn: '+' + payload.service,
                'sbr_csacalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                sbr_devicecallcode: payload.event,
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_deviceident: payload.bsia.account,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_event: payload.event,
                sbr_extendedcallcode: `Ch${payload.location} - ${context.device['sbr_channel' + payload.location + '@OData.Community.Display.V1.FormattedValue']}`,
                sbr_extendedevent: payload.bsia.eventCode.sbr_name,
                'sbr_finalcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                'sbr_initialcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_operatorcallendreasonid@odata.bind': context.endReasonId && `/sbr_operatorcallendreasons(${context.endReasonId})`,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };
        } else if (payload.tt) { // TT92/TTNew/TTOld
            var events = payload.events || [payload.event];
            context.cdr = context.callCode && {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                sbr_callcode: payload.location, // NOWIP:LL
                //sbr_callid: session.evoId,
                sbr_callstarttime: now,
                sbr_callstarttimelocal: now,
                sbr_callstatus: context.callStatus,
                sbr_calluuid: session.evoId,
                sbr_cli: '+' + payload.e164,
                sbr_cpn: '+' + payload.service,
                'sbr_csacalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                sbr_devicecallcode: payload.event,
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_deviceident: session.communicator.grouped ? +payload.unit : payload.originUser,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_event: events[0], // NOWIP:EEESS
                sbr_extendedcallcode: context.locationCode.sbr_name, // NOWIP:LL test
                sbr_extendedevent: (context.eventCodes[0] || {}).sbr_name, // NOWIP:EEESS text
                'sbr_finalcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                'sbr_initialcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_operatorcallendreasonid@odata.bind': context.endReasonId && `/sbr_operatorcallendreasons(${context.endReasonId})`,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };
            if (context.callCode && !context.cdr.sbr_extendedevent)
                context.cdr.sbr_extendedevent = `${(context.eventCodes[1] || {}).sbr_name || '?'} - ${(context.eventCodes[2] || {}).sbr_name || '?'}`;
        } else if (payload.bs8521) { // BS8521
            context.cdr = context.callCode && {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                sbr_callcode: payload.location, // NOWIP:LL
                //sbr_callid: session.evoId,
                sbr_callstarttime: now,
                sbr_callstarttimelocal: now,
                sbr_callstatus: context.callStatus, // Pre Call
                sbr_calluuid: session.evoId,
                sbr_cli: '+' + payload.e164,
                sbr_cpn: '+' + payload.service,
                'sbr_csacalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                sbr_devicecallcode: payload.event,
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_deviceident: session.communicator.grouped ? +payload.unit : payload.originUser,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_event: payload.events[0], // NOWIP:EEESS
                sbr_extendedcallcode: context.locationCode.sbr_name, // NOWIP:LL test
                sbr_extendedevent: (context.eventCodes[0] || {}).sbr_name, // NOWIP:EEESS text
                'sbr_finalcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                'sbr_initialcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_operatorcallendreasonid@odata.bind': context.endReasonId && `/sbr_operatorcallendreasons(${context.endReasonId})`,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };
            if (context.device && !context.cdr.sbr_extendedevent)
                context.cdr.sbr_extendedevent = `${(context.eventCodes[1] || {}).sbr_name || '?'} - ${(context.eventCodes[2] || {}).sbr_name || '?'}`;
        } else if (payload.mrq) { // SCAIP
            context.cdr = context.callCode && {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                sbr_callcode: payload.location, // SCAIP:LCO
                //sbr_callid: session.evoId,
                sbr_callstarttime: now,
                sbr_callstarttimelocal: now,
                sbr_callstatus: context.callStatus, // Pre Call
                sbr_calluuid: session.evoId,
                sbr_cli: payload.e164 ? '+' + payload.e164 : payload.originUser,
                sbr_cpn: session.firstEvt.headers['to_user'],
                'sbr_csacalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                sbr_devicecallcode: payload.event,
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_deviceident: session.communicator.grouped ? +payload.unit : payload.originUser,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_event: payload.events[0], // SCAIP:*DTY*STC
                sbr_extendedcallcode: context.locationCode.sbr_name, // SCAIP:LCO text
                sbr_extendedevent: (context.eventCodes[0] || {}).sbr_name, // SCAIP:*DTY*STC text
                'sbr_finalcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                'sbr_initialcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_operatorcallendreasonid@odata.bind': context.endReasonId && `/sbr_operatorcallendreasons(${context.endReasonId})`,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };
            if (context.callCode && !context.cdr.sbr_extendedevent)
                context.cdr.sbr_extendedevent = `${(context.eventCodes[1] || {}).sbr_name || '?'} - ${(context.eventCodes[2] || {}).sbr_name || '?'}`;

        } else if (payload.ATM) { // NOWIP
            context.cdr = context.callCode && {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                sbr_callcode: payload.location, // NOWIP:LL
                //sbr_callid: session.evoId,
                sbr_callstarttime: now,
                sbr_callstarttimelocal: now,
                sbr_callstatus: context.callStatus, // Pre Call
                sbr_calluuid: session.evoId,
                sbr_cli: session.firstEvt.headers['Caller-Caller-ID-Number'],
                sbr_cpn: session.firstEvt.headers['Caller-Destination-Number'],
                'sbr_csacalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                sbr_devicecallcode: payload.event,
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_deviceident: session.communicator.grouped ? +payload.unit : payload.originUser,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_event: payload.events[0], // NOWIP:EEESS
                sbr_extendedcallcode: context.locationCode.sbr_name, // NOWIP:LL test
                sbr_extendedevent: (context.eventCodes[0] || {}).sbr_name, // NOWIP:EEESS text
                'sbr_finalcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                'sbr_initialcalltypeid@odata.bind': context.calltypeId && `/sbr_calltypes(${context.calltypeId})`,
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_operatorcallendreasonid@odata.bind': context.endReasonId && `/sbr_operatorcallendreasons(${context.endReasonId})`,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };
            if (context.callCode && !context.cdr.sbr_extendedevent)
                context.cdr.sbr_extendedevent = `${(context.eventCodes[1] || {}).sbr_name || '?'} - ${(context.eventCodes[2] || {}).sbr_name || '?'}`;
        } else { // No Protocol
            context.cdr = {
                'sbr_authorityid@odata.bind': context.device['S.sbr_authorityid'] && `/sbr_authorities(${context.device['S.sbr_authorityid']})`,
                //sbr_callid: session.evoId,
                sbr_callstarttime: now,
                sbr_callstarttimelocal: now,
                sbr_callstatus: context.callStatus,
                sbr_calluuid: session.evoId,
                sbr_cli: session.firstEvt.headers['Caller-Caller-ID-Number'],
                sbr_cpn: session.firstEvt.headers['Caller-Destination-Number'],
                sbr_csaserverhostname: session.firstEvt.headers['FreeSWITCH-Hostname'],
                //sbr_csaserveripaddress: session.firstEvt.headers['FreeSWITCH-IPv6'],
                'sbr_deviceid@odata.bind': context.device.sbr_deviceid && `/sbr_devices(${context.device.sbr_deviceid})`,
                sbr_direction: 858810000, // In
                sbr_endpoint: false, // Offsite
                sbr_name: session.evoId,
                sbr_oasisid: session.cid.dec,
                'sbr_protocolid@odata.bind': `/sbr_protocols(${context.protocolId})`,
                'sbr_schemeid@odata.bind': context.device._sbr_schemeid_value && `/sbr_schemes(${context.device._sbr_schemeid_value})`,
                sbr_schemeident: context.device['S.sbr_schemenumber'],
                'sbr_serviceproviderid@odata.bind': `/sbr_serviceproviders(${exports.serviceProvider.sbr_serviceproviderid})`,
                'sbr_systemcallendreasonid@odata.bind': context.sysCallEndReason && `/sbr_systemcallendreasons(${context.sysCallEndReason})`,
            };

        }

    }).then(function () { // onWriteCallData
        hr = process.hrtime();
        return context.cdr && axios(context.axios = { // onWriteCallData
            method: 'post',
            baseURL: main.secrets.appello.azureBaseUrl + main.secrets.appello.azureDataUrl,
            headers: {
                Accept: 'application/json, text/plain, */*',
                Authorization: `Bearer ${context.accessToken}`,
                'Content-Type': 'application/json; charset=utf-8',
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                Prefer: 'return=representation',
            },
            url: 'sbr_calls',
            params: {
                $select: 'sbr_callid',
            },
            data: context.cdr,
        });

    }).then(function (res) { // onWriteCallData
        if (!context.cdr)
            return;

        context.cdrMs = hrMs(process.hrtime(hr));
        context.cdr.sbr_callid = res.data.sbr_callid;
        debug(session.sid, 'sbr_call:', context.cdrMs + 'ms', JSON.stringify(context.cdr));

    }).then(function () { // onWriteCallData
        return cb && cb();

    }).catch(function (err) { // onWriteCallData
        context.err = err;
        if (cb)
            return cb(Object.assign(err, { axios: context.axios }));

        if (err.response && err.response.data.error)
            debug(session.sid, 'onWriteCallData:', JSON.stringify(context.axios), '\n' + err.response.data.error.message);
        else
            debug(session.sid, 'onWriteCallData:', JSON.stringify(context.axios), err);

    });
}
