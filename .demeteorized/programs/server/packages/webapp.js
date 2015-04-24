(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Log = Package.logging.Log;
var _ = Package.underscore._;
var RoutePolicy = Package.routepolicy.RoutePolicy;
var Boilerplate = Package['boilerplate-generator'].Boilerplate;
var Spacebars = Package.spacebars.Spacebars;
var HTML = Package.htmljs.HTML;
var Blaze = Package.blaze.Blaze;
var UI = Package.blaze.UI;
var Handlebars = Package.blaze.Handlebars;
var WebAppHashing = Package['webapp-hashing'].WebAppHashing;

/* Package-scope variables */
var WebApp, main, WebAppInternals;

(function () {

//////////////////////////////////////////////////////////////////////////////////////
//                                                                                  //
// packages/webapp/webapp_server.js                                                 //
//                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////
                                                                                    //
////////// Requires //////////                                                      // 1
                                                                                    // 2
var fs = Npm.require("fs");                                                         // 3
var http = Npm.require("http");                                                     // 4
var os = Npm.require("os");                                                         // 5
var path = Npm.require("path");                                                     // 6
var url = Npm.require("url");                                                       // 7
var crypto = Npm.require("crypto");                                                 // 8
                                                                                    // 9
var connect = Npm.require('connect');                                               // 10
var useragent = Npm.require('useragent');                                           // 11
var send = Npm.require('send');                                                     // 12
                                                                                    // 13
var Future = Npm.require('fibers/future');                                          // 14
var Fiber = Npm.require('fibers');                                                  // 15
                                                                                    // 16
var SHORT_SOCKET_TIMEOUT = 5*1000;                                                  // 17
var LONG_SOCKET_TIMEOUT = 120*1000;                                                 // 18
                                                                                    // 19
WebApp = {};                                                                        // 20
WebAppInternals = {};                                                               // 21
                                                                                    // 22
WebApp.defaultArch = 'web.browser';                                                 // 23
                                                                                    // 24
// XXX maps archs to manifests                                                      // 25
WebApp.clientPrograms = {};                                                         // 26
                                                                                    // 27
// XXX maps archs to program path on filesystem                                     // 28
var archPath = {};                                                                  // 29
                                                                                    // 30
var bundledJsCssPrefix;                                                             // 31
                                                                                    // 32
var sha1 = function (contents) {                                                    // 33
  var hash = crypto.createHash('sha1');                                             // 34
  hash.update(contents);                                                            // 35
  return hash.digest('hex');                                                        // 36
};                                                                                  // 37
                                                                                    // 38
var readUtf8FileSync = function (filename) {                                        // 39
  return Meteor.wrapAsync(fs.readFile)(filename, 'utf8');                           // 40
};                                                                                  // 41
                                                                                    // 42
// #BrowserIdentification                                                           // 43
//                                                                                  // 44
// We have multiple places that want to identify the browser: the                   // 45
// unsupported browser page, the appcache package, and, eventually                  // 46
// delivering browser polyfills only as needed.                                     // 47
//                                                                                  // 48
// To avoid detecting the browser in multiple places ad-hoc, we create a            // 49
// Meteor "browser" object. It uses but does not expose the npm                     // 50
// useragent module (we could choose a different mechanism to identify              // 51
// the browser in the future if we wanted to).  The browser object                  // 52
// contains                                                                         // 53
//                                                                                  // 54
// * `name`: the name of the browser in camel case                                  // 55
// * `major`, `minor`, `patch`: integers describing the browser version             // 56
//                                                                                  // 57
// Also here is an early version of a Meteor `request` object, intended             // 58
// to be a high-level description of the request without exposing                   // 59
// details of connect's low-level `req`.  Currently it contains:                    // 60
//                                                                                  // 61
// * `browser`: browser identification object described above                       // 62
// * `url`: parsed url, including parsed query params                               // 63
//                                                                                  // 64
// As a temporary hack there is a `categorizeRequest` function on WebApp which      // 65
// converts a connect `req` to a Meteor `request`. This can go away once smart      // 66
// packages such as appcache are being passed a `request` object directly when      // 67
// they serve content.                                                              // 68
//                                                                                  // 69
// This allows `request` to be used uniformly: it is passed to the html             // 70
// attributes hook, and the appcache package can use it when deciding               // 71
// whether to generate a 404 for the manifest.                                      // 72
//                                                                                  // 73
// Real routing / server side rendering will probably refactor this                 // 74
// heavily.                                                                         // 75
                                                                                    // 76
                                                                                    // 77
// e.g. "Mobile Safari" => "mobileSafari"                                           // 78
var camelCase = function (name) {                                                   // 79
  var parts = name.split(' ');                                                      // 80
  parts[0] = parts[0].toLowerCase();                                                // 81
  for (var i = 1;  i < parts.length;  ++i) {                                        // 82
    parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].substr(1);               // 83
  }                                                                                 // 84
  return parts.join('');                                                            // 85
};                                                                                  // 86
                                                                                    // 87
var identifyBrowser = function (userAgentString) {                                  // 88
  var userAgent = useragent.lookup(userAgentString);                                // 89
  return {                                                                          // 90
    name: camelCase(userAgent.family),                                              // 91
    major: +userAgent.major,                                                        // 92
    minor: +userAgent.minor,                                                        // 93
    patch: +userAgent.patch                                                         // 94
  };                                                                                // 95
};                                                                                  // 96
                                                                                    // 97
// XXX Refactor as part of implementing real routing.                               // 98
WebAppInternals.identifyBrowser = identifyBrowser;                                  // 99
                                                                                    // 100
WebApp.categorizeRequest = function (req) {                                         // 101
  return {                                                                          // 102
    browser: identifyBrowser(req.headers['user-agent']),                            // 103
    url: url.parse(req.url, true)                                                   // 104
  };                                                                                // 105
};                                                                                  // 106
                                                                                    // 107
// HTML attribute hooks: functions to be called to determine any attributes to      // 108
// be added to the '<html>' tag. Each function is passed a 'request' object (see    // 109
// #BrowserIdentification) and should return null or object.                        // 110
var htmlAttributeHooks = [];                                                        // 111
var getHtmlAttributes = function (request) {                                        // 112
  var combinedAttributes  = {};                                                     // 113
  _.each(htmlAttributeHooks || [], function (hook) {                                // 114
    var attributes = hook(request);                                                 // 115
    if (attributes === null)                                                        // 116
      return;                                                                       // 117
    if (typeof attributes !== 'object')                                             // 118
      throw Error("HTML attribute hook must return null or object");                // 119
    _.extend(combinedAttributes, attributes);                                       // 120
  });                                                                               // 121
  return combinedAttributes;                                                        // 122
};                                                                                  // 123
WebApp.addHtmlAttributeHook = function (hook) {                                     // 124
  htmlAttributeHooks.push(hook);                                                    // 125
};                                                                                  // 126
                                                                                    // 127
// Serve app HTML for this URL?                                                     // 128
var appUrl = function (url) {                                                       // 129
  if (url === '/favicon.ico' || url === '/robots.txt')                              // 130
    return false;                                                                   // 131
                                                                                    // 132
  // NOTE: app.manifest is not a web standard like favicon.ico and                  // 133
  // robots.txt. It is a file name we have chosen to use for HTML5                  // 134
  // appcache URLs. It is included here to prevent using an appcache                // 135
  // then removing it from poisoning an app permanently. Eventually,                // 136
  // once we have server side routing, this won't be needed as                      // 137
  // unknown URLs with return a 404 automatically.                                  // 138
  if (url === '/app.manifest')                                                      // 139
    return false;                                                                   // 140
                                                                                    // 141
  // Avoid serving app HTML for declared routes such as /sockjs/.                   // 142
  if (RoutePolicy.classify(url))                                                    // 143
    return false;                                                                   // 144
                                                                                    // 145
  // we currently return app HTML on all URLs by default                            // 146
  return true;                                                                      // 147
};                                                                                  // 148
                                                                                    // 149
                                                                                    // 150
// We need to calculate the client hash after all packages have loaded              // 151
// to give them a chance to populate __meteor_runtime_config__.                     // 152
//                                                                                  // 153
// Calculating the hash during startup means that packages can only                 // 154
// populate __meteor_runtime_config__ during load, not during startup.              // 155
//                                                                                  // 156
// Calculating instead it at the beginning of main after all startup                // 157
// hooks had run would allow packages to also populate                              // 158
// __meteor_runtime_config__ during startup, but that's too late for                // 159
// autoupdate because it needs to have the client hash at startup to                // 160
// insert the auto update version itself into                                       // 161
// __meteor_runtime_config__ to get it to the client.                               // 162
//                                                                                  // 163
// An alternative would be to give autoupdate a "post-start,                        // 164
// pre-listen" hook to allow it to insert the auto update version at                // 165
// the right moment.                                                                // 166
                                                                                    // 167
Meteor.startup(function () {                                                        // 168
  var calculateClientHash = WebAppHashing.calculateClientHash;                      // 169
  WebApp.clientHash = function (archName) {                                         // 170
    archName = archName || WebApp.defaultArch;                                      // 171
    return calculateClientHash(WebApp.clientPrograms[archName].manifest);           // 172
  };                                                                                // 173
                                                                                    // 174
  WebApp.calculateClientHashRefreshable = function (archName) {                     // 175
    archName = archName || WebApp.defaultArch;                                      // 176
    return calculateClientHash(WebApp.clientPrograms[archName].manifest,            // 177
      function (name) {                                                             // 178
        return name === "css";                                                      // 179
      });                                                                           // 180
  };                                                                                // 181
  WebApp.calculateClientHashNonRefreshable = function (archName) {                  // 182
    archName = archName || WebApp.defaultArch;                                      // 183
    return calculateClientHash(WebApp.clientPrograms[archName].manifest,            // 184
      function (name) {                                                             // 185
        return name !== "css";                                                      // 186
      });                                                                           // 187
  };                                                                                // 188
  WebApp.calculateClientHashCordova = function () {                                 // 189
    var archName = 'web.cordova';                                                   // 190
    if (! WebApp.clientPrograms[archName])                                          // 191
      return 'none';                                                                // 192
                                                                                    // 193
    return calculateClientHash(                                                     // 194
      WebApp.clientPrograms[archName].manifest, null, _.pick(                       // 195
        __meteor_runtime_config__, 'PUBLIC_SETTINGS'));                             // 196
  };                                                                                // 197
});                                                                                 // 198
                                                                                    // 199
                                                                                    // 200
                                                                                    // 201
// When we have a request pending, we want the socket timeout to be long, to        // 202
// give ourselves a while to serve it, and to allow sockjs long polls to            // 203
// complete.  On the other hand, we want to close idle sockets relatively           // 204
// quickly, so that we can shut down relatively promptly but cleanly, without       // 205
// cutting off anyone's response.                                                   // 206
WebApp._timeoutAdjustmentRequestCallback = function (req, res) {                    // 207
  // this is really just req.socket.setTimeout(LONG_SOCKET_TIMEOUT);                // 208
  req.setTimeout(LONG_SOCKET_TIMEOUT);                                              // 209
  // Insert our new finish listener to run BEFORE the existing one which removes    // 210
  // the response from the socket.                                                  // 211
  var finishListeners = res.listeners('finish');                                    // 212
  // XXX Apparently in Node 0.12 this event is now called 'prefinish'.              // 213
  // https://github.com/joyent/node/commit/7c9b6070                                 // 214
  res.removeAllListeners('finish');                                                 // 215
  res.on('finish', function () {                                                    // 216
    res.setTimeout(SHORT_SOCKET_TIMEOUT);                                           // 217
  });                                                                               // 218
  _.each(finishListeners, function (l) { res.on('finish', l); });                   // 219
};                                                                                  // 220
                                                                                    // 221
                                                                                    // 222
// Will be updated by main before we listen.                                        // 223
// Map from client arch to boilerplate object.                                      // 224
// Boilerplate object has:                                                          // 225
//   - func: XXX                                                                    // 226
//   - baseData: XXX                                                                // 227
var boilerplateByArch = {};                                                         // 228
                                                                                    // 229
// Given a request (as returned from `categorizeRequest`), return the               // 230
// boilerplate HTML to serve for that request. Memoizes on HTML                     // 231
// attributes (used by, eg, appcache) and whether inline scripts are                // 232
// currently allowed.                                                               // 233
// XXX so far this function is always called with arch === 'web.browser'            // 234
var memoizedBoilerplate = {};                                                       // 235
var getBoilerplate = function (request, arch) {                                     // 236
                                                                                    // 237
  var htmlAttributes = getHtmlAttributes(request);                                  // 238
                                                                                    // 239
  // The only thing that changes from request to request (for now) are              // 240
  // the HTML attributes (used by, eg, appcache) and whether inline                 // 241
  // scripts are allowed, so we can memoize based on that.                          // 242
  var memHash = JSON.stringify({                                                    // 243
    inlineScriptsAllowed: inlineScriptsAllowed,                                     // 244
    htmlAttributes: htmlAttributes,                                                 // 245
    arch: arch                                                                      // 246
  });                                                                               // 247
                                                                                    // 248
  if (! memoizedBoilerplate[memHash]) {                                             // 249
    memoizedBoilerplate[memHash] = boilerplateByArch[arch].toHTML({                 // 250
      htmlAttributes: htmlAttributes                                                // 251
    });                                                                             // 252
  }                                                                                 // 253
  return memoizedBoilerplate[memHash];                                              // 254
};                                                                                  // 255
                                                                                    // 256
WebAppInternals.generateBoilerplateInstance = function (arch,                       // 257
                                                        manifest,                   // 258
                                                        additionalOptions) {        // 259
  additionalOptions = additionalOptions || {};                                      // 260
                                                                                    // 261
  var runtimeConfig = _.extend(                                                     // 262
    _.clone(__meteor_runtime_config__),                                             // 263
    additionalOptions.runtimeConfigOverrides || {}                                  // 264
  );                                                                                // 265
                                                                                    // 266
  var jsCssPrefix;                                                                  // 267
  if (arch === 'web.cordova') {                                                     // 268
    // in cordova we serve assets up directly from disk so it doesn't make          // 269
    // sense to use the prefix (ordinarily something like a CDN) and go out         // 270
    // to the internet for those files.                                             // 271
    jsCssPrefix = '';                                                               // 272
  } else {                                                                          // 273
    jsCssPrefix = bundledJsCssPrefix ||                                             // 274
      __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '';                         // 275
  }                                                                                 // 276
                                                                                    // 277
  return new Boilerplate(arch, manifest,                                            // 278
    _.extend({                                                                      // 279
      pathMapper: function (itemPath) {                                             // 280
        return path.join(archPath[arch], itemPath); },                              // 281
      baseDataExtension: {                                                          // 282
        additionalStaticJs: _.map(                                                  // 283
          additionalStaticJs || [],                                                 // 284
          function (contents, pathname) {                                           // 285
            return {                                                                // 286
              pathname: pathname,                                                   // 287
              contents: contents                                                    // 288
            };                                                                      // 289
          }                                                                         // 290
        ),                                                                          // 291
        meteorRuntimeConfig: JSON.stringify(runtimeConfig),                         // 292
        rootUrlPathPrefix: __meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '',    // 293
        bundledJsCssPrefix: jsCssPrefix,                                            // 294
        inlineScriptsAllowed: WebAppInternals.inlineScriptsAllowed(),               // 295
        inline: additionalOptions.inline                                            // 296
      }                                                                             // 297
    }, additionalOptions)                                                           // 298
  );                                                                                // 299
};                                                                                  // 300
                                                                                    // 301
// A mapping from url path to "info". Where "info" has the following fields:        // 302
// - type: the type of file to be served                                            // 303
// - cacheable: optionally, whether the file should be cached or not                // 304
// - sourceMapUrl: optionally, the url of the source map                            // 305
//                                                                                  // 306
// Info also contains one of the following:                                         // 307
// - content: the stringified content that should be served at this path            // 308
// - absolutePath: the absolute path on disk to the file                            // 309
                                                                                    // 310
var staticFiles;                                                                    // 311
                                                                                    // 312
// Serve static files from the manifest or added with                               // 313
// `addStaticJs`. Exported for tests.                                               // 314
WebAppInternals.staticFilesMiddleware = function (staticFiles, req, res, next) {    // 315
  if ('GET' != req.method && 'HEAD' != req.method) {                                // 316
    next();                                                                         // 317
    return;                                                                         // 318
  }                                                                                 // 319
  var pathname = connect.utils.parseUrl(req).pathname;                              // 320
  try {                                                                             // 321
    pathname = decodeURIComponent(pathname);                                        // 322
  } catch (e) {                                                                     // 323
    next();                                                                         // 324
    return;                                                                         // 325
  }                                                                                 // 326
                                                                                    // 327
  var serveStaticJs = function (s) {                                                // 328
    res.writeHead(200, {                                                            // 329
      'Content-type': 'application/javascript; charset=UTF-8'                       // 330
    });                                                                             // 331
    res.write(s);                                                                   // 332
    res.end();                                                                      // 333
  };                                                                                // 334
                                                                                    // 335
  if (pathname === "/meteor_runtime_config.js" &&                                   // 336
      ! WebAppInternals.inlineScriptsAllowed()) {                                   // 337
    serveStaticJs("__meteor_runtime_config__ = " +                                  // 338
                  JSON.stringify(__meteor_runtime_config__) + ";");                 // 339
    return;                                                                         // 340
  } else if (_.has(additionalStaticJs, pathname) &&                                 // 341
              ! WebAppInternals.inlineScriptsAllowed()) {                           // 342
    serveStaticJs(additionalStaticJs[pathname]);                                    // 343
    return;                                                                         // 344
  }                                                                                 // 345
                                                                                    // 346
  if (!_.has(staticFiles, pathname)) {                                              // 347
    next();                                                                         // 348
    return;                                                                         // 349
  }                                                                                 // 350
                                                                                    // 351
  // We don't need to call pause because, unlike 'static', once we call into        // 352
  // 'send' and yield to the event loop, we never call another handler with         // 353
  // 'next'.                                                                        // 354
                                                                                    // 355
  var info = staticFiles[pathname];                                                 // 356
                                                                                    // 357
  // Cacheable files are files that should never change. Typically                  // 358
  // named by their hash (eg meteor bundled js and css files).                      // 359
  // We cache them ~forever (1yr).                                                  // 360
  //                                                                                // 361
  // We cache non-cacheable files anyway. This isn't really correct, as users       // 362
  // can change the files and changes won't propagate immediately. However, if      // 363
  // we don't cache them, browsers will 'flicker' when rerendering                  // 364
  // images. Eventually we will probably want to rewrite URLs of static assets      // 365
  // to include a query parameter to bust caches. That way we can both get          // 366
  // good caching behavior and allow users to change assets without delay.          // 367
  // https://github.com/meteor/meteor/issues/773                                    // 368
  var maxAge = info.cacheable                                                       // 369
        ? 1000 * 60 * 60 * 24 * 365                                                 // 370
        : 1000 * 60 * 60 * 24;                                                      // 371
                                                                                    // 372
  // Set the X-SourceMap header, which current Chrome, FireFox, and Safari          // 373
  // understand.  (The SourceMap header is slightly more spec-correct but FF        // 374
  // doesn't understand it.)                                                        // 375
  //                                                                                // 376
  // You may also need to enable source maps in Chrome: open dev tools, click       // 377
  // the gear in the bottom right corner, and select "enable source maps".          // 378
  if (info.sourceMapUrl) {                                                          // 379
    res.setHeader('X-SourceMap',                                                    // 380
                  __meteor_runtime_config__.ROOT_URL_PATH_PREFIX +                  // 381
                  info.sourceMapUrl);                                               // 382
  }                                                                                 // 383
                                                                                    // 384
  if (info.type === "js") {                                                         // 385
    res.setHeader("Content-Type", "application/javascript; charset=UTF-8");         // 386
  } else if (info.type === "css") {                                                 // 387
    res.setHeader("Content-Type", "text/css; charset=UTF-8");                       // 388
  } else if (info.type === "json") {                                                // 389
    res.setHeader("Content-Type", "application/json; charset=UTF-8");               // 390
    // XXX if it is a manifest we are serving, set additional headers               // 391
    if (/\/manifest.json$/.test(pathname)) {                                        // 392
      res.setHeader("Access-Control-Allow-Origin", "*");                            // 393
    }                                                                               // 394
  }                                                                                 // 395
                                                                                    // 396
  if (info.content) {                                                               // 397
    res.write(info.content);                                                        // 398
    res.end();                                                                      // 399
  } else {                                                                          // 400
    send(req, info.absolutePath)                                                    // 401
      .maxage(maxAge)                                                               // 402
      .hidden(true)  // if we specified a dotfile in the manifest, serve it         // 403
      .on('error', function (err) {                                                 // 404
        Log.error("Error serving static file " + err);                              // 405
        res.writeHead(500);                                                         // 406
        res.end();                                                                  // 407
      })                                                                            // 408
      .on('directory', function () {                                                // 409
        Log.error("Unexpected directory " + info.absolutePath);                     // 410
        res.writeHead(500);                                                         // 411
        res.end();                                                                  // 412
      })                                                                            // 413
      .pipe(res);                                                                   // 414
  }                                                                                 // 415
};                                                                                  // 416
                                                                                    // 417
var getUrlPrefixForArch = function (arch) {                                         // 418
  // XXX we rely on the fact that arch names don't contain slashes                  // 419
  // in that case we would need to uri escape it                                    // 420
                                                                                    // 421
  // We add '__' to the beginning of non-standard archs to "scope" the url          // 422
  // to Meteor internals.                                                           // 423
  return arch === WebApp.defaultArch ?                                              // 424
    '' : '/' + '__' + arch.replace(/^web\./, '');                                   // 425
};                                                                                  // 426
                                                                                    // 427
var runWebAppServer = function () {                                                 // 428
  var shuttingDown = false;                                                         // 429
  var syncQueue = new Meteor._SynchronousQueue();                                   // 430
                                                                                    // 431
  var getItemPathname = function (itemUrl) {                                        // 432
    return decodeURIComponent(url.parse(itemUrl).pathname);                         // 433
  };                                                                                // 434
                                                                                    // 435
  WebAppInternals.reloadClientPrograms = function () {                              // 436
    syncQueue.runTask(function() {                                                  // 437
      staticFiles = {};                                                             // 438
      var generateClientProgram = function (clientPath, arch) {                     // 439
        // read the control for the client we'll be serving up                      // 440
        var clientJsonPath = path.join(__meteor_bootstrap__.serverDir,              // 441
                                   clientPath);                                     // 442
        var clientDir = path.dirname(clientJsonPath);                               // 443
        var clientJson = JSON.parse(readUtf8FileSync(clientJsonPath));              // 444
        if (clientJson.format !== "web-program-pre1")                               // 445
          throw new Error("Unsupported format for client assets: " +                // 446
                          JSON.stringify(clientJson.format));                       // 447
                                                                                    // 448
        if (! clientJsonPath || ! clientDir || ! clientJson)                        // 449
          throw new Error("Client config file not parsed.");                        // 450
                                                                                    // 451
        var urlPrefix = getUrlPrefixForArch(arch);                                  // 452
                                                                                    // 453
        var manifest = clientJson.manifest;                                         // 454
        _.each(manifest, function (item) {                                          // 455
          if (item.url && item.where === "client") {                                // 456
            staticFiles[urlPrefix + getItemPathname(item.url)] = {                  // 457
              absolutePath: path.join(clientDir, item.path),                        // 458
              cacheable: item.cacheable,                                            // 459
              // Link from source to its map                                        // 460
              sourceMapUrl: item.sourceMapUrl,                                      // 461
              type: item.type                                                       // 462
            };                                                                      // 463
                                                                                    // 464
            if (item.sourceMap) {                                                   // 465
              // Serve the source map too, under the specified URL. We assume all   // 466
              // source maps are cacheable.                                         // 467
              staticFiles[urlPrefix + getItemPathname(item.sourceMapUrl)] = {       // 468
                absolutePath: path.join(clientDir, item.sourceMap),                 // 469
                cacheable: true                                                     // 470
              };                                                                    // 471
            }                                                                       // 472
          }                                                                         // 473
        });                                                                         // 474
                                                                                    // 475
        var program = {                                                             // 476
          manifest: manifest,                                                       // 477
          version: WebAppHashing.calculateClientHash(manifest, null, _.pick(        // 478
            __meteor_runtime_config__, 'PUBLIC_SETTINGS')),                         // 479
          PUBLIC_SETTINGS: __meteor_runtime_config__.PUBLIC_SETTINGS                // 480
        };                                                                          // 481
                                                                                    // 482
        WebApp.clientPrograms[arch] = program;                                      // 483
                                                                                    // 484
        // Serve the program as a string at /foo/<arch>/manifest.json               // 485
        // XXX change manifest.json -> program.json                                 // 486
        staticFiles[path.join(urlPrefix, 'manifest.json')] = {                      // 487
          content: JSON.stringify(program),                                         // 488
          cacheable: true,                                                          // 489
          type: "json"                                                              // 490
        };                                                                          // 491
      };                                                                            // 492
                                                                                    // 493
      try {                                                                         // 494
        var clientPaths = __meteor_bootstrap__.configJson.clientPaths;              // 495
        _.each(clientPaths, function (clientPath, arch) {                           // 496
          archPath[arch] = path.dirname(clientPath);                                // 497
          generateClientProgram(clientPath, arch);                                  // 498
        });                                                                         // 499
                                                                                    // 500
        // Exported for tests.                                                      // 501
        WebAppInternals.staticFiles = staticFiles;                                  // 502
      } catch (e) {                                                                 // 503
        Log.error("Error reloading the client program: " + e.stack);                // 504
        process.exit(1);                                                            // 505
      }                                                                             // 506
    });                                                                             // 507
  };                                                                                // 508
                                                                                    // 509
  WebAppInternals.generateBoilerplate = function () {                               // 510
    // This boilerplate will be served to the mobile devices when used with         // 511
    // Meteor/Cordova for the Hot-Code Push and since the file will be served by    // 512
    // the device's server, it is important to set the DDP url to the actual        // 513
    // Meteor server accepting DDP connections and not the device's file server.    // 514
    var defaultOptionsForArch = {                                                   // 515
      'web.cordova': {                                                              // 516
        runtimeConfigOverrides: {                                                   // 517
          // XXX We use absoluteUrl() here so that we serve https://                // 518
          // URLs to cordova clients if force-ssl is in use. If we were             // 519
          // to use __meteor_runtime_config__.ROOT_URL instead of                   // 520
          // absoluteUrl(), then Cordova clients would immediately get a            // 521
          // HCP setting their DDP_DEFAULT_CONNECTION_URL to                        // 522
          // http://example.meteor.com. This breaks the app, because                // 523
          // force-ssl doesn't serve CORS headers on 302                            // 524
          // redirects. (Plus it's undesirable to have clients                      // 525
          // connecting to http://example.meteor.com when force-ssl is              // 526
          // in use.)                                                               // 527
          DDP_DEFAULT_CONNECTION_URL: process.env.MOBILE_DDP_URL ||                 // 528
            Meteor.absoluteUrl(),                                                   // 529
          ROOT_URL: process.env.MOBILE_ROOT_URL ||                                  // 530
            Meteor.absoluteUrl()                                                    // 531
        }                                                                           // 532
      }                                                                             // 533
    };                                                                              // 534
                                                                                    // 535
    syncQueue.runTask(function() {                                                  // 536
      _.each(WebApp.clientPrograms, function (program, archName) {                  // 537
        boilerplateByArch[archName] =                                               // 538
          WebAppInternals.generateBoilerplateInstance(                              // 539
            archName, program.manifest,                                             // 540
            defaultOptionsForArch[archName]);                                       // 541
      });                                                                           // 542
                                                                                    // 543
      // Clear the memoized boilerplate cache.                                      // 544
      memoizedBoilerplate = {};                                                     // 545
                                                                                    // 546
      // Configure CSS injection for the default arch                               // 547
      // XXX implement the CSS injection for all archs?                             // 548
      WebAppInternals.refreshableAssets = {                                         // 549
        allCss: boilerplateByArch[WebApp.defaultArch].baseData.css                  // 550
      };                                                                            // 551
    });                                                                             // 552
  };                                                                                // 553
                                                                                    // 554
  WebAppInternals.reloadClientPrograms();                                           // 555
                                                                                    // 556
  // webserver                                                                      // 557
  var app = connect();                                                              // 558
                                                                                    // 559
  // Auto-compress any json, javascript, or text.                                   // 560
  app.use(connect.compress());                                                      // 561
                                                                                    // 562
  // Packages and apps can add handlers that run before any other Meteor            // 563
  // handlers via WebApp.rawConnectHandlers.                                        // 564
  var rawConnectHandlers = connect();                                               // 565
  app.use(rawConnectHandlers);                                                      // 566
                                                                                    // 567
  // We're not a proxy; reject (without crashing) attempts to treat us like         // 568
  // one. (See #1212.)                                                              // 569
  app.use(function(req, res, next) {                                                // 570
    if (RoutePolicy.isValidUrl(req.url)) {                                          // 571
      next();                                                                       // 572
      return;                                                                       // 573
    }                                                                               // 574
    res.writeHead(400);                                                             // 575
    res.write("Not a proxy");                                                       // 576
    res.end();                                                                      // 577
  });                                                                               // 578
                                                                                    // 579
  // Strip off the path prefix, if it exists.                                       // 580
  app.use(function (request, response, next) {                                      // 581
    var pathPrefix = __meteor_runtime_config__.ROOT_URL_PATH_PREFIX;                // 582
    var url = Npm.require('url').parse(request.url);                                // 583
    var pathname = url.pathname;                                                    // 584
    // check if the path in the url starts with the path prefix (and the part       // 585
    // after the path prefix must start with a / if it exists.)                     // 586
    if (pathPrefix && pathname.substring(0, pathPrefix.length) === pathPrefix &&    // 587
       (pathname.length == pathPrefix.length                                        // 588
        || pathname.substring(pathPrefix.length, pathPrefix.length + 1) === "/")) { // 589
      request.url = request.url.substring(pathPrefix.length);                       // 590
      next();                                                                       // 591
    } else if (pathname === "/favicon.ico" || pathname === "/robots.txt") {         // 592
      next();                                                                       // 593
    } else if (pathPrefix) {                                                        // 594
      response.writeHead(404);                                                      // 595
      response.write("Unknown path");                                               // 596
      response.end();                                                               // 597
    } else {                                                                        // 598
      next();                                                                       // 599
    }                                                                               // 600
  });                                                                               // 601
                                                                                    // 602
  // Parse the query string into res.query. Used by oauth_server, but it's          // 603
  // generally pretty handy..                                                       // 604
  app.use(connect.query());                                                         // 605
                                                                                    // 606
  // Serve static files from the manifest.                                          // 607
  // This is inspired by the 'static' middleware.                                   // 608
  app.use(function (req, res, next) {                                               // 609
    Fiber(function () {                                                             // 610
     WebAppInternals.staticFilesMiddleware(staticFiles, req, res, next);            // 611
    }).run();                                                                       // 612
  });                                                                               // 613
                                                                                    // 614
  // Packages and apps can add handlers to this via WebApp.connectHandlers.         // 615
  // They are inserted before our default handler.                                  // 616
  var packageAndAppHandlers = connect();                                            // 617
  app.use(packageAndAppHandlers);                                                   // 618
                                                                                    // 619
  var suppressConnectErrors = false;                                                // 620
  // connect knows it is an error handler because it has 4 arguments instead of     // 621
  // 3. go figure.  (It is not smart enough to find such a thing if it's hidden     // 622
  // inside packageAndAppHandlers.)                                                 // 623
  app.use(function (err, req, res, next) {                                          // 624
    if (!err || !suppressConnectErrors || !req.headers['x-suppress-error']) {       // 625
      next(err);                                                                    // 626
      return;                                                                       // 627
    }                                                                               // 628
    res.writeHead(err.status, { 'Content-Type': 'text/plain' });                    // 629
    res.end("An error message");                                                    // 630
  });                                                                               // 631
                                                                                    // 632
  app.use(function (req, res, next) {                                               // 633
    if (! appUrl(req.url))                                                          // 634
      return next();                                                                // 635
                                                                                    // 636
    var headers = {                                                                 // 637
      'Content-Type':  'text/html; charset=utf-8'                                   // 638
    };                                                                              // 639
    if (shuttingDown)                                                               // 640
      headers['Connection'] = 'Close';                                              // 641
                                                                                    // 642
    var request = WebApp.categorizeRequest(req);                                    // 643
                                                                                    // 644
    if (request.url.query && request.url.query['meteor_css_resource']) {            // 645
      // In this case, we're requesting a CSS resource in the meteor-specific       // 646
      // way, but we don't have it.  Serve a static css file that indicates that    // 647
      // we didn't have it, so we can detect that and refresh.                      // 648
      headers['Content-Type'] = 'text/css; charset=utf-8';                          // 649
      res.writeHead(200, headers);                                                  // 650
      res.write(".meteor-css-not-found-error { width: 0px;}");                      // 651
      res.end();                                                                    // 652
      return undefined;                                                             // 653
    }                                                                               // 654
                                                                                    // 655
    // /packages/asdfsad ... /__cordova/dafsdf.js                                   // 656
    var pathname = connect.utils.parseUrl(req).pathname;                            // 657
    var archKey = pathname.split('/')[1];                                           // 658
    var archKeyCleaned = 'web.' + archKey.replace(/^__/, '');                       // 659
                                                                                    // 660
    if (! /^__/.test(archKey) || ! _.has(archPath, archKeyCleaned)) {               // 661
      archKey = WebApp.defaultArch;                                                 // 662
    } else {                                                                        // 663
      archKey = archKeyCleaned;                                                     // 664
    }                                                                               // 665
                                                                                    // 666
    var boilerplate;                                                                // 667
    try {                                                                           // 668
      boilerplate = getBoilerplate(request, archKey);                               // 669
    } catch (e) {                                                                   // 670
      Log.error("Error running template: " + e);                                    // 671
      res.writeHead(500, headers);                                                  // 672
      res.end();                                                                    // 673
      return undefined;                                                             // 674
    }                                                                               // 675
                                                                                    // 676
    res.writeHead(200, headers);                                                    // 677
    res.write(boilerplate);                                                         // 678
    res.end();                                                                      // 679
    return undefined;                                                               // 680
  });                                                                               // 681
                                                                                    // 682
  // Return 404 by default, if no other handlers serve this URL.                    // 683
  app.use(function (req, res) {                                                     // 684
    res.writeHead(404);                                                             // 685
    res.end();                                                                      // 686
  });                                                                               // 687
                                                                                    // 688
                                                                                    // 689
  var httpServer = http.createServer(app);                                          // 690
  var onListeningCallbacks = [];                                                    // 691
                                                                                    // 692
  // After 5 seconds w/o data on a socket, kill it.  On the other hand, if          // 693
  // there's an outstanding request, give it a higher timeout instead (to avoid     // 694
  // killing long-polling requests)                                                 // 695
  httpServer.setTimeout(SHORT_SOCKET_TIMEOUT);                                      // 696
                                                                                    // 697
  // Do this here, and then also in livedata/stream_server.js, because              // 698
  // stream_server.js kills all the current request handlers when installing its    // 699
  // own.                                                                           // 700
  httpServer.on('request', WebApp._timeoutAdjustmentRequestCallback);               // 701
                                                                                    // 702
                                                                                    // 703
  // start up app                                                                   // 704
  _.extend(WebApp, {                                                                // 705
    connectHandlers: packageAndAppHandlers,                                         // 706
    rawConnectHandlers: rawConnectHandlers,                                         // 707
    httpServer: httpServer,                                                         // 708
    // For testing.                                                                 // 709
    suppressConnectErrors: function () {                                            // 710
      suppressConnectErrors = true;                                                 // 711
    },                                                                              // 712
    onListening: function (f) {                                                     // 713
      if (onListeningCallbacks)                                                     // 714
        onListeningCallbacks.push(f);                                               // 715
      else                                                                          // 716
        f();                                                                        // 717
    },                                                                              // 718
    // Hack: allow http tests to call connect.basicAuth without making them         // 719
    // Npm.depends on another copy of connect. (That would be fine if we could      // 720
    // have test-only NPM dependencies but is overkill here.)                       // 721
    __basicAuth__: connect.basicAuth                                                // 722
  });                                                                               // 723
                                                                                    // 724
  // Let the rest of the packages (and Meteor.startup hooks) insert connect         // 725
  // middlewares and update __meteor_runtime_config__, then keep going to set up    // 726
  // actually serving HTML.                                                         // 727
  main = function (argv) {                                                          // 728
    WebAppInternals.generateBoilerplate();                                          // 729
                                                                                    // 730
    // only start listening after all the startup code has run.                     // 731
    var localPort = parseInt(process.env.PORT) || 0;                                // 732
    var host = process.env.BIND_IP;                                                 // 733
    var localIp = host || '0.0.0.0';                                                // 734
    httpServer.listen(localPort, localIp, Meteor.bindEnvironment(function() {       // 735
      if (process.env.METEOR_PRINT_ON_LISTEN)                                       // 736
        console.log("LISTENING"); // must match run-app.js                          // 737
                                                                                    // 738
      var callbacks = onListeningCallbacks;                                         // 739
      onListeningCallbacks = null;                                                  // 740
      _.each(callbacks, function (x) { x(); });                                     // 741
                                                                                    // 742
    }, function (e) {                                                               // 743
      console.error("Error listening:", e);                                         // 744
      console.error(e && e.stack);                                                  // 745
    }));                                                                            // 746
                                                                                    // 747
    return 'DAEMON';                                                                // 748
  };                                                                                // 749
};                                                                                  // 750
                                                                                    // 751
                                                                                    // 752
runWebAppServer();                                                                  // 753
                                                                                    // 754
                                                                                    // 755
var inlineScriptsAllowed = true;                                                    // 756
                                                                                    // 757
WebAppInternals.inlineScriptsAllowed = function () {                                // 758
  return inlineScriptsAllowed;                                                      // 759
};                                                                                  // 760
                                                                                    // 761
WebAppInternals.setInlineScriptsAllowed = function (value) {                        // 762
  inlineScriptsAllowed = value;                                                     // 763
  WebAppInternals.generateBoilerplate();                                            // 764
};                                                                                  // 765
                                                                                    // 766
WebAppInternals.setBundledJsCssPrefix = function (prefix) {                         // 767
  bundledJsCssPrefix = prefix;                                                      // 768
  WebAppInternals.generateBoilerplate();                                            // 769
};                                                                                  // 770
                                                                                    // 771
// Packages can call `WebAppInternals.addStaticJs` to specify static                // 772
// JavaScript to be included in the app. This static JS will be inlined,            // 773
// unless inline scripts have been disabled, in which case it will be               // 774
// served under `/<sha1 of contents>`.                                              // 775
var additionalStaticJs = {};                                                        // 776
WebAppInternals.addStaticJs = function (contents) {                                 // 777
  additionalStaticJs["/" + sha1(contents) + ".js"] = contents;                      // 778
};                                                                                  // 779
                                                                                    // 780
// Exported for tests                                                               // 781
WebAppInternals.getBoilerplate = getBoilerplate;                                    // 782
WebAppInternals.additionalStaticJs = additionalStaticJs;                            // 783
                                                                                    // 784
//////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.webapp = {
  WebApp: WebApp,
  main: main,
  WebAppInternals: WebAppInternals
};

})();

//# sourceMappingURL=webapp.js.map
