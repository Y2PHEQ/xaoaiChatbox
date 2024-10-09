"use strict";

var utils = require("./utils");
var cheerio = require("cheerio");
var log = require("npmlog");

var checkVerified = null;

var defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

function setOptions(globalOptions, options) {
    Object.keys(options).map(function (key) {
        switch (key) {
            case 'pauseLog':
                if (options.pauseLog) log.pause();
                break;
            case 'online':
                globalOptions.online = Boolean(options.online);
                break;
            case 'logLevel':
                log.level = options.logLevel;
                globalOptions.logLevel = options.logLevel;
                break;
            case 'logRecordSize':
                log.maxRecordSize = options.logRecordSize;
                globalOptions.logRecordSize = options.logRecordSize;
                break;
            case 'selfListen':
                globalOptions.selfListen = Boolean(options.selfListen);
                break;
            case 'listenEvents':
                globalOptions.listenEvents = Boolean(options.listenEvents);
                break;
            case 'pageID':
                globalOptions.pageID = options.pageID.toString();
                break;
            case 'updatePresence':
                globalOptions.updatePresence = Boolean(options.updatePresence);
                break;
            case 'forceLogin':
                globalOptions.forceLogin = Boolean(options.forceLogin);
                break;
            case 'userAgent':
                globalOptions.userAgent = options.userAgent;
                break;
            case 'autoMarkDelivery':
                globalOptions.autoMarkDelivery = Boolean(options.autoMarkDelivery);
                break;
            case 'autoMarkRead':
                globalOptions.autoMarkRead = Boolean(options.autoMarkRead);
                break;
            case 'listenTyping':
                globalOptions.listenTyping = Boolean(options.listenTyping);
                break;
            case 'proxy':
                if (typeof options.proxy != "string") {
                    delete globalOptions.proxy;
                    utils.setProxy();
                } else {
                    globalOptions.proxy = options.proxy;
                    utils.setProxy(globalOptions.proxy);
                }
                break;
            case 'autoReconnect':
                globalOptions.autoReconnect = Boolean(options.autoReconnect);
                break;
            case 'emitReady':
                globalOptions.emitReady = Boolean(options.emitReady);
                break;
            default:
                log.warn("setOptions", "Unrecognized option given to setOptions: " + key);
                break;
        }
    });
}

function buildAPI(globalOptions, html, jar) {
    var userID;
    var cookie = jar.getCookies("https://www.facebook.com");
    var maybeUser = cookie.filter(function (val) {
        return val.cookieString().split("=")[0] === "c_user";
    });
    var maybeTiktik = cookie.filter(function (val) {
        return val.cookieString().split("=")[0] === "i_user";
    });
    if (maybeUser.length === 0 && maybeTiktik.length === 0) {
        throw {
            error:
            "Error retrieving userID. This can be caused by a lot of things, including getting blocked by Facebook for logging in from an unknown location. Try logging in with a browser to verify.",
        };
    } else {
        if (html.indexOf("/checkpoint/block/?next") > -1) {
            return log.warn(
                "login",
                "Checkpoint detected. Please log in with a browser to verify."
            );
        }
        if (maybeTiktik[0] && maybeTiktik[0].cookieString().includes('i_user')) {
            userID = maybeTiktik[0].cookieString().split("=")[1].toString();
        } else {
            userID = maybeUser[0].cookieString().split("=")[1].toString();
        }
    }

    try {
        clearInterval(checkVerified);
    } catch (_) {}

    var clientID = (Math.random() * 2147483648 | 0).toString(16);

    let oldFBMQTTMatch = html.match(/irisSeqID:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/);
    let mqttEndpoint = null;
    let region = null;
    let irisSeqID = null;
    var noMqttData = null;

    if (oldFBMQTTMatch) {
        irisSeqID = oldFBMQTTMatch[1];
        mqttEndpoint = oldFBMQTTMatch[2];
        region = new URL(mqttEndpoint).searchParams.get("region").toUpperCase();

    } else {
        let newFBMQTTMatch = html.match(/{"app_id":"219994525426954","endpoint":"(.+?)","iris_seq_id":"(.+?)"}/);
        if (newFBMQTTMatch) {
            irisSeqID = newFBMQTTMatch[2];
            mqttEndpoint = newFBMQTTMatch[1].replace(/\\\//g, "/");
            region = new URL(mqttEndpoint).searchParams.get("region").toUpperCase();

        } else {
            let legacyFBMQTTMatch = html.match(/(\["MqttWebConfig",\[\],{fbid:")(.+?)(",appID:219994525426954,endpoint:")(.+?)(",pollingEndpoint:")(.+?)(3790])/);
            if (legacyFBMQTTMatch) {
                mqttEndpoint = legacyFBMQTTMatch[4];
                region = new URL(mqttEndpoint).searchParams.get("region").toUpperCase();

            } else {
                /*    log.warn("login", "Cannot get MQTT region & sequence ID.");*/
                log.info("login", "Successful!")
                noMqttData = html;
            }
        }
    }

    // All data available to api functions
    var ctx = {
        userID: userID,
        jar: jar,
        clientID: clientID,
        globalOptions: globalOptions,
        loggedIn: true,
        access_token: 'NONE',
        clientMutationId: 0,
        mqttClient: undefined,
        lastSeqId: irisSeqID,
        syncToken: undefined,
        mqttEndpoint,
        region,
        firstListen: true
    };

    var api = {
        setOptions: setOptions.bind(null, globalOptions),
        getAppState: function getAppState() {
            return utils.getAppState(jar);
        }
    };

    if (noMqttData) api["htmlData"] = noMqttData;

    var defaultFuncs = utils.makeDefaults(html, userID, ctx);

    // Load all api functions in a loop
    require('node:fs')
    .readdirSync(__dirname + '/src/')
    .filter((v) => v.endsWith('.js'))
    .map(function (v) {
        api[v.replace('.js', '')] = require('./src/' + v)(defaultFuncs, api, ctx);
    });

    //Removing original `listen` that uses pull.
    //Map it to listenMqtt instead for backward compatibly.
    api.listen = api.listenMqtt;

    return [ctx,
        defaultFuncs,
        api];
}

function makeLogin(jar, email, password, loginOptions, callback, prCallback) {
    return function (res) {
        var html = res.body;
        var $ = cheerio.load(html);
        var arr = [];

        // This will be empty, but just to be sure we leave it
        $("#login_form input").map((i, v) => arr.push({
            val: $(v).val(), name: $(v).attr("name")
        }));

        arr = arr.filter(function (v) {
            return v.val && v.val.length;
        });

        var form = utils.arrToForm(arr);
        form.lsd = utils.getFrom(html, "[\"LSD\",[],{\"token\":\"", "\"}");
        form.lgndim = Buffer.from("{\"w\":1440,\"h\":900,\"aw\":1440,\"ah\":834,\"c\":24}").toString('base64');
        form.email = email;
        form.pass = password;
        form.default_persistent = '0';
        form.lgnrnd = utils.getFrom(html, "name=\"lgnrnd\" value=\"", "\"");
        form.locale = 'en_US';
        form.timezone = '240';
        form.lgnjs = ~~(Date.now() / 1000);


        // Getting cookies from the HTML page... (kill me now plz)
        // we used to get a bunch of cookies in the headers of the response of the
        // request, but FB changed and they now send those cookies inside the JS.
        // They run the JS which then injects the cookies in the page.
        // The "solution" is to parse through the html and find those cookies
        // which happen to be conveniently indicated with a _js_ in front of their
        // variable name.
        //
        // ---------- Very Hacky Part Starts -----------------
        var willBeCookies = html.split("\"_js_");
        willBeCookies.slice(1).map(function (val) {
            var cookieData = JSON.parse("[\"" + utils.getFrom(val, "", "]") + "]");
            jar.setCookie(utils.formatCookie(cookieData, "facebook"), "https://www.facebook.com");
        });
        // ---------- Very Hacky Part Ends -----------------


        return utils
        .post("https://www.facebook.com/login/device-based/regular/login/?login_attempt=1&lwv=110", jar, form, loginOptions)
        .then(utils.saveCookies(jar))
        .then(function (res) {
            var headers = res.headers;
            if (!headers.location) throw {
                error: "Wrong username/password."
            };

            // This means the account has login approvals turned on.
            if (headers.location.indexOf('https://www.facebook.com/checkpoint/') > -1) {
                log.info("login", "You have login approvals turned on.");
                var nextURL = 'https://www.facebook.com/checkpoint/?next=https%3A%2F%2Fwww.facebook.com%2Fhome.php';

                return utils
                .get(headers.location, jar, null, loginOptions)
                .then(utils.saveCookies(jar))
                .then(function (res) {
                    var html = res.body;
                    // Make the form in advance which will contain the fb_dtsg and nh
                    var $ = cheerio.load(html);
                    var arr = [];
                    $("form input").map((i, v) => arr.push({
                        val: $(v).val(), name: $(v).attr("name")
                    }));

                    arr = arr.filter(function (v) {
                        return v.val && v.val.length;
                    });

                    var form = utils.arrToForm(arr);
                    if (html.indexOf("checkpoint/?next") > -1) {
                        setTimeout(() => {
                            checkVerified = setInterval((_form) => {}, 5000, {
                                fb_dtsg: form.fb_dtsg,
                                jazoest: form.jazoest,
                                dpr: 1
                            });
                        }, 2500);
                        throw {
                            error: 'login-approval',
                            continue: function submit2FA(code) {
                                form.approvals_code = code;
                                form['submit[Continue]'] = $("#checkpointSubmitButton").html(); //'Continue';
                                var prResolve = null;
                                var prReject = null;
                                var rtPromise = new Promise(function (resolve, reject) {
                                    prResolve = resolve;
                                    prReject = reject;
                                });
                                if (typeof code == "string") {
                                    utils
                                    .post(nextURL, jar, form, loginOptions)
                                    .then(utils.saveCookies(jar))
                                    .then(function (res) {
                                        var $ = cheerio.load(res.body);
                                        var error = $("#approvals_code").parent().attr("data-xui-error");
                                        if (error) {
                                            throw {
                                                error: 'login-approval',
                                                errordesc: "Invalid 2FA code.",
                                                lerror: error,
                                                continue: submit2FA
                                            };
                                        }
                                    })
                                    .then(function () {
                                        // Use the same form (safe I hope)
                                        delete form.no_fido;
                                        delete form.approvals_code;
                                        form.name_action_selected = 'dont_save'; //'save_device';

                                        return utils.post(nextURL, jar, form, loginOptions).then(utils.saveCookies(jar));
                                    })
                                    .then(function (res) {
                                        var headers = res.headers;
                                        if (!headers.location && res.body.indexOf('Review Recent Login') > -1) throw {
                                            error: "Something went wrong with login approvals."
                                        };

                                        var appState = utils.getAppState(jar);

                                        if (callback === prCallback) {
                                            callback = function (err, api) {
                                                if (err) return prReject(err);
                                                return prResolve(api);
                                            };
                                        }

                                        // Simply call loginHelper because all it needs is the jar
                                        // and will then complete the login process
                                        return loginHelper(appState, email, password, loginOptions, callback);
                                    })
                                    .catch(function (err) {
                                        // Check if using Promise instead of callback
                                        if (callback === prCallback) prReject(err);
                                        else callback(err);
                                    });
                                } else {
                                    utils
                                    .post("https://www.facebook.com/checkpoint/?next=https%3A%2F%2Fwww.facebook.com%2Fhome.php", jar, form, loginOptions, null, {
                                        "Referer": "https://www.facebook.com/checkpoint/?next"
                                    })
                                    .then(utils.saveCookies(jar))
                                    .then(res => {
                                        try {
                                            JSON.parse(res.body.replace(/for\s*\(\s*;\s*;\s*\)\s*;\s*/, ""));
                                        } catch (ex) {
                                            clearInterval(checkVerified);
                                            log.info("login", "Verified from browser. Logging in...");
                                            if (callback === prCallback) {
                                                callback = function (err, api) {
                                                    if (err) return prReject(err);
                                                    return prResolve(api);
                                                };
                                            }
                                            return loginHelper(utils.getAppState(jar), email, password, loginOptions, callback);
                                        }
                                    })
                                    .catch(ex => {
                                        log.error("login", ex);
                                        if (callback === prCallback) prReject(ex);
                                        else callback(ex);
                                    });
                                }
                                return rtPromise;
                            }
                        };
                    } else {
                        if (!loginOptions.forceLogin) throw {
                            error: "Couldn't login. Facebook might have blocked this account. Please login with a browser or enable the option 'forceLogin' and try again."
                        };

                        if (html.indexOf("Suspicious Login Attempt") > -1) form['submit[This was me]'] = "This was me";
                        else form['submit[This Is Okay]'] = "This Is Okay";

                        return utils
                        .post(nextURL, jar, form, loginOptions)
                        .then(utils.saveCookies(jar))
                        .then(function () {
                            // Use the same form (safe I hope)
                            form.name_action_selected = 'save_device';

                            return utils.post(nextURL, jar, form, loginOptions).then(utils.saveCookies(jar));
                        })
                        .then(function (res) {
                            var headers = res.headers;

                            if (!headers.location && res.body.indexOf('Review Recent Login') > -1) throw {
                                error: "Something went wrong with review recent login."
                            };

                            var appState = utils.getAppState(jar);

                            // Simply call loginHelper because all it needs is the jar
                            // and will then complete the login process
                            return loginHelper(appState, email, password, loginOptions, callback);
                        })
                        .catch(e => callback(e));
                    }
                });
            }

            return utils.get('https://www.facebook.com/', jar, null, loginOptions).then(utils.saveCookies(jar));
        });
    };
}

// Helps the login
function loginHelper(appState, email, password, globalOptions, callback, prCallback) {
    var mainPromise = null;
    var jar = utils.getJar();

    // If we're given an appState we loop through it and save each cookie
    // back into the jar.
    if (appState) {
        appState.map(function (c) {
            var str = c.key + "=" + c.value + "; expires=" + c.expires + "; domain=" + c.domain + "; path=" + c.path + ";";
            jar.setCookie(str, "http://" + c.domain);
        });

        // Load the main page.
        mainPromise = utils.get('https://www.facebook.com/', jar, null, globalOptions, {
            noRef: true
        }).then(utils.saveCookies(jar));
    } else {
        // Open the main page, then we login with the given credentials and finally
        // load the main page again (it'll give us some IDs that we need)
        mainPromise = utils
        .get("https://www.facebook.com/", null, null, globalOptions, {
            noRef: true
        })
        .then(utils.saveCookies(jar))
        .then(makeLogin(jar, email, password, globalOptions, callback, prCallback))
        .then(function () {
            return utils.get('https://www.facebook.com/', jar, null, globalOptions).then(utils.saveCookies(jar));
        });
    }
    let redirect = [1,
        "https://m.facebook.com/"],
    bypass_region_err = false,
    ctx,
    _defaultFuncs,
    api;
    function CheckAndFixErr(res) {
        let reg_antierr = /This browser is not supported/gs; // =))))))
        if (reg_antierr.test(res.body)) {
            const Data = JSON.stringify(res.body);
            const Dt_Check = Data.split('2Fhome.php&amp;gfid=')[1];
            if (Dt_Check == undefined) return res
            const fid = Dt_Check.split("\\\\")[0]; //fix sau
            if (Dt_Check == undefined || Dt_Check == "") return res
            const final_fid = fid.split(`\\`)[0];
            if (final_fid == undefined || final_fid == '') return res;
            const redirectlink = redirect[1] + "a/preferences.php?basic_site_devices=m_basic&uri=" + encodeURIComponent("https://m.facebook.com/home.php") + "&gfid=" + final_fid;
            bypass_region_err = true;
            return utils.get(redirectlink, jar, null, globalOptions).then(utils.saveCookies(jar));
        } else return res
    }

    function Redirect(res) {
        var reg = /<meta http-equiv="refresh" content="0;url=([^"]+)[^>]+>/;
        redirect = reg.exec(res.body);
        if (redirect && redirect[1]) return utils.get(redirect[1], jar, null, globalOptions).then(utils.saveCookies(jar));
        return res;
    }
    mainPromise = mainPromise
    .then(res => Redirect(res))
    .then(res => CheckAndFixErr(res))

    //fix via login with defaut UA return WWW.facebook.com not m.facebook.com

    .then(function (res) {
        let Regex_Via = /MPageLoadClientMetrics/gs; //default for normal account, can easily get region, without this u can't get region in some case but u can run normal
        if (!Regex_Via.test(res.body)) {
            //www.facebook.com
            globalOptions.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
            return utils.get('https://www.facebook.com/', jar, null, globalOptions, {
                noRef: true
            }).then(utils.saveCookies(jar));
        } else return res
    })
    .then(res => Redirect(res))
    .then(res => CheckAndFixErr(res))
    .then(function (res) {
        var html = res.body;
        var stuff = buildAPI(globalOptions, html, jar);
        ctx = stuff[0];
        _defaultFuncs = stuff[1];
        api = stuff[2];
        return res;
    });

    // given a pageID we log in as a page
    if (globalOptions.pageID) {
        mainPromise = mainPromise
        .then(function () {
            return utils.get('https://www.facebook.com/' + ctx.globalOptions.pageID + '/messages/?section=messages&subsection=inbox', ctx.jar, null, globalOptions);
        })
        .then(function (resData) {
            var url = utils.getFrom(resData.body, 'window.location.replace("https:\\/\\/www.facebook.com\\', '");').split('\\').join('');
            url = url.substring(0, url.length - 1);
            return utils.get('https://www.facebook.com' + url, ctx.jar, null, globalOptions);
        });
    }

    // At the end we call the callback or catch an exception
    mainPromise
    .then(function () {

        return callback(null, api);
    })
    .catch(function (e) {
        log.error("login", e.error || e);
        callback(e);
    });
}

function login(loginData, options, callback) {
    if (utils.getType(options) === 'Function' || utils.getType(options) === 'AsyncFunction') {
        callback = options;
        options = {};
    }
    /// Bằng cách nào đó tắt Online sẽ đánh lừa đc Fb
    var globalOptions = {
        selfListen: false,
        listenEvents: true,
        listenTyping: false,
        updatePresence: false,
        forceLogin: false,
        autoMarkDelivery: true,
        autoMarkRead: false,
        autoReconnect: true,
        logRecordSize: defaultLogRecordSize,
        online: false,
        emitReady: false,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_2) AppleWebKit/600.3.18 (KHTML, like Gecko) Version/8.0.3 Safari/600.3.18"
    };

    setOptions(globalOptions, options);

    var prCallback = null;
    if (utils.getType(callback) !== "Function" && utils.getType(callback) !== "AsyncFunction") {
        var rejectFunc = null;
        var resolveFunc = null;
        var returnPromise = new Promise(function (resolve, reject) {
            resolveFunc = resolve;
            rejectFunc = reject;
        });
        prCallback = function (error, api) {
            if (error) return rejectFunc(error);
            return resolveFunc(api);
        };
        callback = prCallback;
    }
    loginHelper(loginData.appState, loginData.email, loginData.password, globalOptions, callback, prCallback);
    return returnPromise;
}

module.exports = login;