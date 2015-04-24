(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var _ = Package.underscore._;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var Log = Package.logging.Log;
var DDP = Package.ddp.DDP;
var DDPServer = Package.ddp.DDPServer;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var check = Package.check.check;
var Match = Package.check.Match;
var MaxHeap = Package['binary-heap'].MaxHeap;
var MinHeap = Package['binary-heap'].MinHeap;
var MinMaxHeap = Package['binary-heap'].MinMaxHeap;
var Hook = Package['callback-hook'].Hook;

/* Package-scope variables */
var MongoInternals, MongoTest, Mongo, MongoConnection, CursorDescription, Cursor, listenAll, forEachTrigger, OPLOG_COLLECTION, idForOp, OplogHandle, ObserveMultiplexer, ObserveHandle, DocFetcher, PollingObserveDriver, OplogObserveDriver, LocalCollectionDriver;

(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/mongo_driver.js                                                                                     //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
/**                                                                                                                   // 1
 * Provide a synchronous Collection API using fibers, backed by                                                       // 2
 * MongoDB.  This is only for use on the server, and mostly identical                                                 // 3
 * to the client API.                                                                                                 // 4
 *                                                                                                                    // 5
 * NOTE: the public API methods must be run within a fiber. If you call                                               // 6
 * these outside of a fiber they will explode!                                                                        // 7
 */                                                                                                                   // 8
                                                                                                                      // 9
var path = Npm.require('path');                                                                                       // 10
var MongoDB = Npm.require('mongodb');                                                                                 // 11
var Fiber = Npm.require('fibers');                                                                                    // 12
var Future = Npm.require(path.join('fibers', 'future'));                                                              // 13
                                                                                                                      // 14
MongoInternals = {};                                                                                                  // 15
MongoTest = {};                                                                                                       // 16
                                                                                                                      // 17
// This is used to add or remove EJSON from the beginning of everything nested                                        // 18
// inside an EJSON custom type. It should only be called on pure JSON!                                                // 19
var replaceNames = function (filter, thing) {                                                                         // 20
  if (typeof thing === "object") {                                                                                    // 21
    if (_.isArray(thing)) {                                                                                           // 22
      return _.map(thing, _.bind(replaceNames, null, filter));                                                        // 23
    }                                                                                                                 // 24
    var ret = {};                                                                                                     // 25
    _.each(thing, function (value, key) {                                                                             // 26
      ret[filter(key)] = replaceNames(filter, value);                                                                 // 27
    });                                                                                                               // 28
    return ret;                                                                                                       // 29
  }                                                                                                                   // 30
  return thing;                                                                                                       // 31
};                                                                                                                    // 32
                                                                                                                      // 33
// Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just                                          // 34
// doing a structural clone).                                                                                         // 35
// XXX how ok is this? what if there are multiple copies of MongoDB loaded?                                           // 36
MongoDB.Timestamp.prototype.clone = function () {                                                                     // 37
  // Timestamps should be immutable.                                                                                  // 38
  return this;                                                                                                        // 39
};                                                                                                                    // 40
                                                                                                                      // 41
var makeMongoLegal = function (name) { return "EJSON" + name; };                                                      // 42
var unmakeMongoLegal = function (name) { return name.substr(5); };                                                    // 43
                                                                                                                      // 44
var replaceMongoAtomWithMeteor = function (document) {                                                                // 45
  if (document instanceof MongoDB.Binary) {                                                                           // 46
    var buffer = document.value(true);                                                                                // 47
    return new Uint8Array(buffer);                                                                                    // 48
  }                                                                                                                   // 49
  if (document instanceof MongoDB.ObjectID) {                                                                         // 50
    return new Mongo.ObjectID(document.toHexString());                                                                // 51
  }                                                                                                                   // 52
  if (document["EJSON$type"] && document["EJSON$value"]                                                               // 53
      && _.size(document) === 2) {                                                                                    // 54
    return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));                                             // 55
  }                                                                                                                   // 56
  if (document instanceof MongoDB.Timestamp) {                                                                        // 57
    // For now, the Meteor representation of a Mongo timestamp type (not a date!                                      // 58
    // this is a weird internal thing used in the oplog!) is the same as the                                          // 59
    // Mongo representation. We need to do this explicitly or else we would do a                                      // 60
    // structural clone and lose the prototype.                                                                       // 61
    return document;                                                                                                  // 62
  }                                                                                                                   // 63
  return undefined;                                                                                                   // 64
};                                                                                                                    // 65
                                                                                                                      // 66
var replaceMeteorAtomWithMongo = function (document) {                                                                // 67
  if (EJSON.isBinary(document)) {                                                                                     // 68
    // This does more copies than we'd like, but is necessary because                                                 // 69
    // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually                                       // 70
    // serialize it correctly).                                                                                       // 71
    return new MongoDB.Binary(new Buffer(document));                                                                  // 72
  }                                                                                                                   // 73
  if (document instanceof Mongo.ObjectID) {                                                                           // 74
    return new MongoDB.ObjectID(document.toHexString());                                                              // 75
  }                                                                                                                   // 76
  if (document instanceof MongoDB.Timestamp) {                                                                        // 77
    // For now, the Meteor representation of a Mongo timestamp type (not a date!                                      // 78
    // this is a weird internal thing used in the oplog!) is the same as the                                          // 79
    // Mongo representation. We need to do this explicitly or else we would do a                                      // 80
    // structural clone and lose the prototype.                                                                       // 81
    return document;                                                                                                  // 82
  }                                                                                                                   // 83
  if (EJSON._isCustomType(document)) {                                                                                // 84
    return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));                                                 // 85
  }                                                                                                                   // 86
  // It is not ordinarily possible to stick dollar-sign keys into mongo                                               // 87
  // so we don't bother checking for things that need escaping at this time.                                          // 88
  return undefined;                                                                                                   // 89
};                                                                                                                    // 90
                                                                                                                      // 91
var replaceTypes = function (document, atomTransformer) {                                                             // 92
  if (typeof document !== 'object' || document === null)                                                              // 93
    return document;                                                                                                  // 94
                                                                                                                      // 95
  var replacedTopLevelAtom = atomTransformer(document);                                                               // 96
  if (replacedTopLevelAtom !== undefined)                                                                             // 97
    return replacedTopLevelAtom;                                                                                      // 98
                                                                                                                      // 99
  var ret = document;                                                                                                 // 100
  _.each(document, function (val, key) {                                                                              // 101
    var valReplaced = replaceTypes(val, atomTransformer);                                                             // 102
    if (val !== valReplaced) {                                                                                        // 103
      // Lazy clone. Shallow copy.                                                                                    // 104
      if (ret === document)                                                                                           // 105
        ret = _.clone(document);                                                                                      // 106
      ret[key] = valReplaced;                                                                                         // 107
    }                                                                                                                 // 108
  });                                                                                                                 // 109
  return ret;                                                                                                         // 110
};                                                                                                                    // 111
                                                                                                                      // 112
                                                                                                                      // 113
MongoConnection = function (url, options) {                                                                           // 114
  var self = this;                                                                                                    // 115
  options = options || {};                                                                                            // 116
  self._observeMultiplexers = {};                                                                                     // 117
  self._onFailoverHook = new Hook;                                                                                    // 118
                                                                                                                      // 119
  var mongoOptions = {db: {safe: true}, server: {}, replSet: {}};                                                     // 120
                                                                                                                      // 121
  // Set autoReconnect to true, unless passed on the URL. Why someone                                                 // 122
  // would want to set autoReconnect to false, I'm not really sure, but                                               // 123
  // keeping this for backwards compatibility for now.                                                                // 124
  if (!(/[\?&]auto_?[rR]econnect=/.test(url))) {                                                                      // 125
    mongoOptions.server.auto_reconnect = true;                                                                        // 126
  }                                                                                                                   // 127
                                                                                                                      // 128
  // Disable the native parser by default, unless specifically enabled                                                // 129
  // in the mongo URL.                                                                                                // 130
  // - The native driver can cause errors which normally would be                                                     // 131
  //   thrown, caught, and handled into segfaults that take down the                                                  // 132
  //   whole app.                                                                                                     // 133
  // - Binary modules don't yet work when you bundle and move the bundle                                              // 134
  //   to a different platform (aka deploy)                                                                           // 135
  // We should revisit this after binary npm module support lands.                                                    // 136
  if (!(/[\?&]native_?[pP]arser=/.test(url))) {                                                                       // 137
    mongoOptions.db.native_parser = false;                                                                            // 138
  }                                                                                                                   // 139
                                                                                                                      // 140
  // XXX maybe we should have a better way of allowing users to configure the                                         // 141
  // underlying Mongo driver                                                                                          // 142
  if (_.has(options, 'poolSize')) {                                                                                   // 143
    // If we just set this for "server", replSet will override it. If we just                                         // 144
    // set it for replSet, it will be ignored if we're not using a replSet.                                           // 145
    mongoOptions.server.poolSize = options.poolSize;                                                                  // 146
    mongoOptions.replSet.poolSize = options.poolSize;                                                                 // 147
  }                                                                                                                   // 148
                                                                                                                      // 149
  self.db = null;                                                                                                     // 150
  // We keep track of the ReplSet's primary, so that we can trigger hooks when                                        // 151
  // it changes.  The Node driver's joined callback seems to fire way too                                             // 152
  // often, which is why we need to track it ourselves.                                                               // 153
  self._primary = null;                                                                                               // 154
  self._oplogHandle = null;                                                                                           // 155
  self._docFetcher = null;                                                                                            // 156
                                                                                                                      // 157
                                                                                                                      // 158
  var connectFuture = new Future;                                                                                     // 159
  MongoDB.connect(                                                                                                    // 160
    url,                                                                                                              // 161
    mongoOptions,                                                                                                     // 162
    Meteor.bindEnvironment(                                                                                           // 163
      function (err, db) {                                                                                            // 164
        if (err) {                                                                                                    // 165
          throw err;                                                                                                  // 166
        }                                                                                                             // 167
                                                                                                                      // 168
        // First, figure out what the current primary is, if any.                                                     // 169
        if (db.serverConfig._state.master)                                                                            // 170
          self._primary = db.serverConfig._state.master.name;                                                         // 171
        db.serverConfig.on(                                                                                           // 172
          'joined', Meteor.bindEnvironment(function (kind, doc) {                                                     // 173
            if (kind === 'primary') {                                                                                 // 174
              if (doc.primary !== self._primary) {                                                                    // 175
                self._primary = doc.primary;                                                                          // 176
                self._onFailoverHook.each(function (callback) {                                                       // 177
                  callback();                                                                                         // 178
                  return true;                                                                                        // 179
                });                                                                                                   // 180
              }                                                                                                       // 181
            } else if (doc.me === self._primary) {                                                                    // 182
              // The thing we thought was primary is now something other than                                         // 183
              // primary.  Forget that we thought it was primary.  (This means                                        // 184
              // that if a server stops being primary and then starts being                                           // 185
              // primary again without another server becoming primary in the                                         // 186
              // middle, we'll correctly count it as a failover.)                                                     // 187
              self._primary = null;                                                                                   // 188
            }                                                                                                         // 189
          }));                                                                                                        // 190
                                                                                                                      // 191
        // Allow the constructor to return.                                                                           // 192
        connectFuture['return'](db);                                                                                  // 193
      },                                                                                                              // 194
      connectFuture.resolver()  // onException                                                                        // 195
    )                                                                                                                 // 196
  );                                                                                                                  // 197
                                                                                                                      // 198
  // Wait for the connection to be successful; throws on failure.                                                     // 199
  self.db = connectFuture.wait();                                                                                     // 200
                                                                                                                      // 201
  if (options.oplogUrl && ! Package['disable-oplog']) {                                                               // 202
    self._oplogHandle = new OplogHandle(options.oplogUrl, self.db.databaseName);                                      // 203
    self._docFetcher = new DocFetcher(self);                                                                          // 204
  }                                                                                                                   // 205
};                                                                                                                    // 206
                                                                                                                      // 207
MongoConnection.prototype.close = function() {                                                                        // 208
  var self = this;                                                                                                    // 209
                                                                                                                      // 210
  if (! self.db)                                                                                                      // 211
    throw Error("close called before Connection created?");                                                           // 212
                                                                                                                      // 213
  // XXX probably untested                                                                                            // 214
  var oplogHandle = self._oplogHandle;                                                                                // 215
  self._oplogHandle = null;                                                                                           // 216
  if (oplogHandle)                                                                                                    // 217
    oplogHandle.stop();                                                                                               // 218
                                                                                                                      // 219
  // Use Future.wrap so that errors get thrown. This happens to                                                       // 220
  // work even outside a fiber since the 'close' method is not                                                        // 221
  // actually asynchronous.                                                                                           // 222
  Future.wrap(_.bind(self.db.close, self.db))(true).wait();                                                           // 223
};                                                                                                                    // 224
                                                                                                                      // 225
// Returns the Mongo Collection object; may yield.                                                                    // 226
MongoConnection.prototype._getCollection = function (collectionName) {                                                // 227
  var self = this;                                                                                                    // 228
                                                                                                                      // 229
  if (! self.db)                                                                                                      // 230
    throw Error("_getCollection called before Connection created?");                                                  // 231
                                                                                                                      // 232
  var future = new Future;                                                                                            // 233
  self.db.collection(collectionName, future.resolver());                                                              // 234
  return future.wait();                                                                                               // 235
};                                                                                                                    // 236
                                                                                                                      // 237
MongoConnection.prototype._createCappedCollection = function (                                                        // 238
    collectionName, byteSize, maxDocuments) {                                                                         // 239
  var self = this;                                                                                                    // 240
                                                                                                                      // 241
  if (! self.db)                                                                                                      // 242
    throw Error("_createCappedCollection called before Connection created?");                                         // 243
                                                                                                                      // 244
  var future = new Future();                                                                                          // 245
  self.db.createCollection(                                                                                           // 246
    collectionName,                                                                                                   // 247
    { capped: true, size: byteSize, max: maxDocuments },                                                              // 248
    future.resolver());                                                                                               // 249
  future.wait();                                                                                                      // 250
};                                                                                                                    // 251
                                                                                                                      // 252
// This should be called synchronously with a write, to create a                                                      // 253
// transaction on the current write fence, if any. After we can read                                                  // 254
// the write, and after observers have been notified (or at least,                                                    // 255
// after the observer notifiers have added themselves to the write                                                    // 256
// fence), you should call 'committed()' on the object returned.                                                      // 257
MongoConnection.prototype._maybeBeginWrite = function () {                                                            // 258
  var self = this;                                                                                                    // 259
  var fence = DDPServer._CurrentWriteFence.get();                                                                     // 260
  if (fence)                                                                                                          // 261
    return fence.beginWrite();                                                                                        // 262
  else                                                                                                                // 263
    return {committed: function () {}};                                                                               // 264
};                                                                                                                    // 265
                                                                                                                      // 266
// Internal interface: adds a callback which is called when the Mongo primary                                         // 267
// changes. Returns a stop handle.                                                                                    // 268
MongoConnection.prototype._onFailover = function (callback) {                                                         // 269
  return this._onFailoverHook.register(callback);                                                                     // 270
};                                                                                                                    // 271
                                                                                                                      // 272
                                                                                                                      // 273
//////////// Public API //////////                                                                                    // 274
                                                                                                                      // 275
// The write methods block until the database has confirmed the write (it may                                         // 276
// not be replicated or stable on disk, but one server has confirmed it) if no                                        // 277
// callback is provided. If a callback is provided, then they call the callback                                       // 278
// when the write is confirmed. They return nothing on success, and raise an                                          // 279
// exception on failure.                                                                                              // 280
//                                                                                                                    // 281
// After making a write (with insert, update, remove), observers are                                                  // 282
// notified asynchronously. If you want to receive a callback once all                                                // 283
// of the observer notifications have landed for your write, do the                                                   // 284
// writes inside a write fence (set DDPServer._CurrentWriteFence to a new                                             // 285
// _WriteFence, and then set a callback on the write fence.)                                                          // 286
//                                                                                                                    // 287
// Since our execution environment is single-threaded, this is                                                        // 288
// well-defined -- a write "has been made" if it's returned, and an                                                   // 289
// observer "has been notified" if its callback has returned.                                                         // 290
                                                                                                                      // 291
var writeCallback = function (write, refresh, callback) {                                                             // 292
  return function (err, result) {                                                                                     // 293
    if (! err) {                                                                                                      // 294
      // XXX We don't have to run this on error, right?                                                               // 295
      refresh();                                                                                                      // 296
    }                                                                                                                 // 297
    write.committed();                                                                                                // 298
    if (callback)                                                                                                     // 299
      callback(err, result);                                                                                          // 300
    else if (err)                                                                                                     // 301
      throw err;                                                                                                      // 302
  };                                                                                                                  // 303
};                                                                                                                    // 304
                                                                                                                      // 305
var bindEnvironmentForWrite = function (callback) {                                                                   // 306
  return Meteor.bindEnvironment(callback, "Mongo write");                                                             // 307
};                                                                                                                    // 308
                                                                                                                      // 309
MongoConnection.prototype._insert = function (collection_name, document,                                              // 310
                                              callback) {                                                             // 311
  var self = this;                                                                                                    // 312
                                                                                                                      // 313
  var sendError = function (e) {                                                                                      // 314
    if (callback)                                                                                                     // 315
      return callback(e);                                                                                             // 316
    throw e;                                                                                                          // 317
  };                                                                                                                  // 318
                                                                                                                      // 319
  if (collection_name === "___meteor_failure_test_collection") {                                                      // 320
    var e = new Error("Failure test");                                                                                // 321
    e.expected = true;                                                                                                // 322
    sendError(e);                                                                                                     // 323
    return;                                                                                                           // 324
  }                                                                                                                   // 325
                                                                                                                      // 326
  if (!(LocalCollection._isPlainObject(document) &&                                                                   // 327
        !EJSON._isCustomType(document))) {                                                                            // 328
    sendError(new Error(                                                                                              // 329
      "Only plain objects may be inserted into MongoDB"));                                                            // 330
    return;                                                                                                           // 331
  }                                                                                                                   // 332
                                                                                                                      // 333
  var write = self._maybeBeginWrite();                                                                                // 334
  var refresh = function () {                                                                                         // 335
    Meteor.refresh({collection: collection_name, id: document._id });                                                 // 336
  };                                                                                                                  // 337
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));                                        // 338
  try {                                                                                                               // 339
    var collection = self._getCollection(collection_name);                                                            // 340
    collection.insert(replaceTypes(document, replaceMeteorAtomWithMongo),                                             // 341
                      {safe: true}, callback);                                                                        // 342
  } catch (e) {                                                                                                       // 343
    write.committed();                                                                                                // 344
    throw e;                                                                                                          // 345
  }                                                                                                                   // 346
};                                                                                                                    // 347
                                                                                                                      // 348
// Cause queries that may be affected by the selector to poll in this write                                           // 349
// fence.                                                                                                             // 350
MongoConnection.prototype._refresh = function (collectionName, selector) {                                            // 351
  var self = this;                                                                                                    // 352
  var refreshKey = {collection: collectionName};                                                                      // 353
  // If we know which documents we're removing, don't poll queries that are                                           // 354
  // specific to other documents. (Note that multiple notifications here should                                       // 355
  // not cause multiple polls, since all our listener is doing is enqueueing a                                        // 356
  // poll.)                                                                                                           // 357
  var specificIds = LocalCollection._idsMatchedBySelector(selector);                                                  // 358
  if (specificIds) {                                                                                                  // 359
    _.each(specificIds, function (id) {                                                                               // 360
      Meteor.refresh(_.extend({id: id}, refreshKey));                                                                 // 361
    });                                                                                                               // 362
  } else {                                                                                                            // 363
    Meteor.refresh(refreshKey);                                                                                       // 364
  }                                                                                                                   // 365
};                                                                                                                    // 366
                                                                                                                      // 367
MongoConnection.prototype._remove = function (collection_name, selector,                                              // 368
                                              callback) {                                                             // 369
  var self = this;                                                                                                    // 370
                                                                                                                      // 371
  if (collection_name === "___meteor_failure_test_collection") {                                                      // 372
    var e = new Error("Failure test");                                                                                // 373
    e.expected = true;                                                                                                // 374
    if (callback)                                                                                                     // 375
      return callback(e);                                                                                             // 376
    else                                                                                                              // 377
      throw e;                                                                                                        // 378
  }                                                                                                                   // 379
                                                                                                                      // 380
  var write = self._maybeBeginWrite();                                                                                // 381
  var refresh = function () {                                                                                         // 382
    self._refresh(collection_name, selector);                                                                         // 383
  };                                                                                                                  // 384
  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));                                        // 385
                                                                                                                      // 386
  try {                                                                                                               // 387
    var collection = self._getCollection(collection_name);                                                            // 388
    collection.remove(replaceTypes(selector, replaceMeteorAtomWithMongo),                                             // 389
                      {safe: true}, callback);                                                                        // 390
  } catch (e) {                                                                                                       // 391
    write.committed();                                                                                                // 392
    throw e;                                                                                                          // 393
  }                                                                                                                   // 394
};                                                                                                                    // 395
                                                                                                                      // 396
MongoConnection.prototype._dropCollection = function (collectionName, cb) {                                           // 397
  var self = this;                                                                                                    // 398
                                                                                                                      // 399
  var write = self._maybeBeginWrite();                                                                                // 400
  var refresh = function () {                                                                                         // 401
    Meteor.refresh({collection: collectionName, id: null,                                                             // 402
                    dropCollection: true});                                                                           // 403
  };                                                                                                                  // 404
  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));                                                    // 405
                                                                                                                      // 406
  try {                                                                                                               // 407
    var collection = self._getCollection(collectionName);                                                             // 408
    collection.drop(cb);                                                                                              // 409
  } catch (e) {                                                                                                       // 410
    write.committed();                                                                                                // 411
    throw e;                                                                                                          // 412
  }                                                                                                                   // 413
};                                                                                                                    // 414
                                                                                                                      // 415
MongoConnection.prototype._update = function (collection_name, selector, mod,                                         // 416
                                              options, callback) {                                                    // 417
  var self = this;                                                                                                    // 418
                                                                                                                      // 419
  if (! callback && options instanceof Function) {                                                                    // 420
    callback = options;                                                                                               // 421
    options = null;                                                                                                   // 422
  }                                                                                                                   // 423
                                                                                                                      // 424
  if (collection_name === "___meteor_failure_test_collection") {                                                      // 425
    var e = new Error("Failure test");                                                                                // 426
    e.expected = true;                                                                                                // 427
    if (callback)                                                                                                     // 428
      return callback(e);                                                                                             // 429
    else                                                                                                              // 430
      throw e;                                                                                                        // 431
  }                                                                                                                   // 432
                                                                                                                      // 433
  // explicit safety check. null and undefined can crash the mongo                                                    // 434
  // driver. Although the node driver and minimongo do 'support'                                                      // 435
  // non-object modifier in that they don't crash, they are not                                                       // 436
  // meaningful operations and do not do anything. Defensively throw an                                               // 437
  // error here.                                                                                                      // 438
  if (!mod || typeof mod !== 'object')                                                                                // 439
    throw new Error("Invalid modifier. Modifier must be an object.");                                                 // 440
                                                                                                                      // 441
  if (!(LocalCollection._isPlainObject(mod) &&                                                                        // 442
        !EJSON._isCustomType(mod))) {                                                                                 // 443
    throw new Error(                                                                                                  // 444
      "Only plain objects may be used as replacement" +                                                               // 445
        " documents in MongoDB");                                                                                     // 446
    return;                                                                                                           // 447
  }                                                                                                                   // 448
                                                                                                                      // 449
  if (!options) options = {};                                                                                         // 450
                                                                                                                      // 451
  var write = self._maybeBeginWrite();                                                                                // 452
  var refresh = function () {                                                                                         // 453
    self._refresh(collection_name, selector);                                                                         // 454
  };                                                                                                                  // 455
  callback = writeCallback(write, refresh, callback);                                                                 // 456
  try {                                                                                                               // 457
    var collection = self._getCollection(collection_name);                                                            // 458
    var mongoOpts = {safe: true};                                                                                     // 459
    // explictly enumerate options that minimongo supports                                                            // 460
    if (options.upsert) mongoOpts.upsert = true;                                                                      // 461
    if (options.multi) mongoOpts.multi = true;                                                                        // 462
                                                                                                                      // 463
    var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithMongo);                                           // 464
    var mongoMod = replaceTypes(mod, replaceMeteorAtomWithMongo);                                                     // 465
                                                                                                                      // 466
    var isModify = isModificationMod(mongoMod);                                                                       // 467
    var knownId = selector._id || mod._id;                                                                            // 468
                                                                                                                      // 469
    if (options._forbidReplace && ! isModify) {                                                                       // 470
      var e = new Error("Invalid modifier. Replacements are forbidden.");                                             // 471
      if (callback) {                                                                                                 // 472
        return callback(e);                                                                                           // 473
      } else {                                                                                                        // 474
        throw e;                                                                                                      // 475
      }                                                                                                               // 476
    }                                                                                                                 // 477
                                                                                                                      // 478
    if (options.upsert && (! knownId) && options.insertedId) {                                                        // 479
      // XXX If we know we're using Mongo 2.6 (and this isn't a replacement)                                          // 480
      //     we should be able to just use $setOnInsert instead of this                                               // 481
      //     simulated upsert thing. (We can't use $setOnInsert with                                                  // 482
      //     replacements because there's nowhere to write it, and $setOnInsert                                       // 483
      //     can't set _id on Mongo 2.4.)                                                                             // 484
      //                                                                                                              // 485
      //     Also, in the future we could do a real upsert for the mongo id                                           // 486
      //     generation case, if the the node mongo driver gives us back the id                                       // 487
      //     of the upserted doc (which our current version does not).                                                // 488
      //                                                                                                              // 489
      //     For more context, see                                                                                    // 490
      //     https://github.com/meteor/meteor/issues/2278#issuecomment-64252706                                       // 491
      simulateUpsertWithInsertedId(                                                                                   // 492
        collection, mongoSelector, mongoMod,                                                                          // 493
        isModify, options,                                                                                            // 494
        // This callback does not need to be bindEnvironment'ed because                                               // 495
        // simulateUpsertWithInsertedId() wraps it and then passes it through                                         // 496
        // bindEnvironmentForWrite.                                                                                   // 497
        function (err, result) {                                                                                      // 498
          // If we got here via a upsert() call, then options._returnObject will                                      // 499
          // be set and we should return the whole object. Otherwise, we should                                       // 500
          // just return the number of affected docs to match the mongo API.                                          // 501
          if (result && ! options._returnObject)                                                                      // 502
            callback(err, result.numberAffected);                                                                     // 503
          else                                                                                                        // 504
            callback(err, result);                                                                                    // 505
        }                                                                                                             // 506
      );                                                                                                              // 507
    } else {                                                                                                          // 508
      collection.update(                                                                                              // 509
        mongoSelector, mongoMod, mongoOpts,                                                                           // 510
        bindEnvironmentForWrite(function (err, result, extra) {                                                       // 511
          if (! err) {                                                                                                // 512
            if (result && options._returnObject) {                                                                    // 513
              result = { numberAffected: result };                                                                    // 514
              // If this was an upsert() call, and we ended up                                                        // 515
              // inserting a new doc and we know its id, then                                                         // 516
              // return that id as well.                                                                              // 517
              if (options.upsert && knownId &&                                                                        // 518
                  ! extra.updatedExisting)                                                                            // 519
                result.insertedId = knownId;                                                                          // 520
            }                                                                                                         // 521
          }                                                                                                           // 522
          callback(err, result);                                                                                      // 523
        }));                                                                                                          // 524
    }                                                                                                                 // 525
  } catch (e) {                                                                                                       // 526
    write.committed();                                                                                                // 527
    throw e;                                                                                                          // 528
  }                                                                                                                   // 529
};                                                                                                                    // 530
                                                                                                                      // 531
var isModificationMod = function (mod) {                                                                              // 532
  var isReplace = false;                                                                                              // 533
  var isModify = false;                                                                                               // 534
  for (var k in mod) {                                                                                                // 535
    if (k.substr(0, 1) === '$') {                                                                                     // 536
      isModify = true;                                                                                                // 537
    } else {                                                                                                          // 538
      isReplace = true;                                                                                               // 539
    }                                                                                                                 // 540
  }                                                                                                                   // 541
  if (isModify && isReplace) {                                                                                        // 542
    throw new Error(                                                                                                  // 543
      "Update parameter cannot have both modifier and non-modifier fields.");                                         // 544
  }                                                                                                                   // 545
  return isModify;                                                                                                    // 546
};                                                                                                                    // 547
                                                                                                                      // 548
var NUM_OPTIMISTIC_TRIES = 3;                                                                                         // 549
                                                                                                                      // 550
// exposed for testing                                                                                                // 551
MongoConnection._isCannotChangeIdError = function (err) {                                                             // 552
  // First check for what this error looked like in Mongo 2.4.  Either of these                                       // 553
  // checks should work, but just to be safe...                                                                       // 554
  if (err.code === 13596)                                                                                             // 555
    return true;                                                                                                      // 556
  if (err.err.indexOf("cannot change _id of a document") === 0)                                                       // 557
    return true;                                                                                                      // 558
                                                                                                                      // 559
  // Now look for what it looks like in Mongo 2.6.  We don't use the error code                                       // 560
  // here, because the error code we observed it producing (16837) appears to be                                      // 561
  // a far more generic error code based on examining the source.                                                     // 562
  if (err.err.indexOf("The _id field cannot be changed") === 0)                                                       // 563
    return true;                                                                                                      // 564
                                                                                                                      // 565
  return false;                                                                                                       // 566
};                                                                                                                    // 567
                                                                                                                      // 568
var simulateUpsertWithInsertedId = function (collection, selector, mod,                                               // 569
                                             isModify, options, callback) {                                           // 570
  // STRATEGY:  First try doing a plain update.  If it affected 0 documents,                                          // 571
  // then without affecting the database, we know we should probably do an                                            // 572
  // insert.  We then do a *conditional* insert that will fail in the case                                            // 573
  // of a race condition.  This conditional insert is actually an                                                     // 574
  // upsert-replace with an _id, which will never successfully update an                                              // 575
  // existing document.  If this upsert fails with an error saying it                                                 // 576
  // couldn't change an existing _id, then we know an intervening write has                                           // 577
  // caused the query to match something.  We go back to step one and repeat.                                         // 578
  // Like all "optimistic write" schemes, we rely on the fact that it's                                               // 579
  // unlikely our writes will continue to be interfered with under normal                                             // 580
  // circumstances (though sufficiently heavy contention with writers                                                 // 581
  // disagreeing on the existence of an object will cause writes to fail                                              // 582
  // in theory).                                                                                                      // 583
                                                                                                                      // 584
  var newDoc;                                                                                                         // 585
  // Run this code up front so that it fails fast if someone uses                                                     // 586
  // a Mongo update operator we don't support.                                                                        // 587
  if (isModify) {                                                                                                     // 588
    // We've already run replaceTypes/replaceMeteorAtomWithMongo on                                                   // 589
    // selector and mod.  We assume it doesn't matter, as far as                                                      // 590
    // the behavior of modifiers is concerned, whether `_modify`                                                      // 591
    // is run on EJSON or on mongo-converted EJSON.                                                                   // 592
    var selectorDoc = LocalCollection._removeDollarOperators(selector);                                               // 593
    LocalCollection._modify(selectorDoc, mod, {isInsert: true});                                                      // 594
    newDoc = selectorDoc;                                                                                             // 595
  } else {                                                                                                            // 596
    newDoc = mod;                                                                                                     // 597
  }                                                                                                                   // 598
                                                                                                                      // 599
  var insertedId = options.insertedId; // must exist                                                                  // 600
  var mongoOptsForUpdate = {                                                                                          // 601
    safe: true,                                                                                                       // 602
    multi: options.multi                                                                                              // 603
  };                                                                                                                  // 604
  var mongoOptsForInsert = {                                                                                          // 605
    safe: true,                                                                                                       // 606
    upsert: true                                                                                                      // 607
  };                                                                                                                  // 608
                                                                                                                      // 609
  var tries = NUM_OPTIMISTIC_TRIES;                                                                                   // 610
                                                                                                                      // 611
  var doUpdate = function () {                                                                                        // 612
    tries--;                                                                                                          // 613
    if (! tries) {                                                                                                    // 614
      callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));                                 // 615
    } else {                                                                                                          // 616
      collection.update(selector, mod, mongoOptsForUpdate,                                                            // 617
                        bindEnvironmentForWrite(function (err, result) {                                              // 618
                          if (err)                                                                                    // 619
                            callback(err);                                                                            // 620
                          else if (result)                                                                            // 621
                            callback(null, {                                                                          // 622
                              numberAffected: result                                                                  // 623
                            });                                                                                       // 624
                          else                                                                                        // 625
                            doConditionalInsert();                                                                    // 626
                        }));                                                                                          // 627
    }                                                                                                                 // 628
  };                                                                                                                  // 629
                                                                                                                      // 630
  var doConditionalInsert = function () {                                                                             // 631
    var replacementWithId = _.extend(                                                                                 // 632
      replaceTypes({_id: insertedId}, replaceMeteorAtomWithMongo),                                                    // 633
      newDoc);                                                                                                        // 634
    collection.update(selector, replacementWithId, mongoOptsForInsert,                                                // 635
                      bindEnvironmentForWrite(function (err, result) {                                                // 636
                        if (err) {                                                                                    // 637
                          // figure out if this is a                                                                  // 638
                          // "cannot change _id of document" error, and                                               // 639
                          // if so, try doUpdate() again, up to 3 times.                                              // 640
                          if (MongoConnection._isCannotChangeIdError(err)) {                                          // 641
                            doUpdate();                                                                               // 642
                          } else {                                                                                    // 643
                            callback(err);                                                                            // 644
                          }                                                                                           // 645
                        } else {                                                                                      // 646
                          callback(null, {                                                                            // 647
                            numberAffected: result,                                                                   // 648
                            insertedId: insertedId                                                                    // 649
                          });                                                                                         // 650
                        }                                                                                             // 651
                      }));                                                                                            // 652
  };                                                                                                                  // 653
                                                                                                                      // 654
  doUpdate();                                                                                                         // 655
};                                                                                                                    // 656
                                                                                                                      // 657
_.each(["insert", "update", "remove", "dropCollection"], function (method) {                                          // 658
  MongoConnection.prototype[method] = function (/* arguments */) {                                                    // 659
    var self = this;                                                                                                  // 660
    return Meteor.wrapAsync(self["_" + method]).apply(self, arguments);                                               // 661
  };                                                                                                                  // 662
});                                                                                                                   // 663
                                                                                                                      // 664
// XXX MongoConnection.upsert() does not return the id of the inserted document                                       // 665
// unless you set it explicitly in the selector or modifier (as a replacement                                         // 666
// doc).                                                                                                              // 667
MongoConnection.prototype.upsert = function (collectionName, selector, mod,                                           // 668
                                             options, callback) {                                                     // 669
  var self = this;                                                                                                    // 670
  if (typeof options === "function" && ! callback) {                                                                  // 671
    callback = options;                                                                                               // 672
    options = {};                                                                                                     // 673
  }                                                                                                                   // 674
                                                                                                                      // 675
  return self.update(collectionName, selector, mod,                                                                   // 676
                     _.extend({}, options, {                                                                          // 677
                       upsert: true,                                                                                  // 678
                       _returnObject: true                                                                            // 679
                     }), callback);                                                                                   // 680
};                                                                                                                    // 681
                                                                                                                      // 682
MongoConnection.prototype.find = function (collectionName, selector, options) {                                       // 683
  var self = this;                                                                                                    // 684
                                                                                                                      // 685
  if (arguments.length === 1)                                                                                         // 686
    selector = {};                                                                                                    // 687
                                                                                                                      // 688
  return new Cursor(                                                                                                  // 689
    self, new CursorDescription(collectionName, selector, options));                                                  // 690
};                                                                                                                    // 691
                                                                                                                      // 692
MongoConnection.prototype.findOne = function (collection_name, selector,                                              // 693
                                              options) {                                                              // 694
  var self = this;                                                                                                    // 695
  if (arguments.length === 1)                                                                                         // 696
    selector = {};                                                                                                    // 697
                                                                                                                      // 698
  options = options || {};                                                                                            // 699
  options.limit = 1;                                                                                                  // 700
  return self.find(collection_name, selector, options).fetch()[0];                                                    // 701
};                                                                                                                    // 702
                                                                                                                      // 703
// We'll actually design an index API later. For now, we just pass through to                                         // 704
// Mongo's, but make it synchronous.                                                                                  // 705
MongoConnection.prototype._ensureIndex = function (collectionName, index,                                             // 706
                                                   options) {                                                         // 707
  var self = this;                                                                                                    // 708
  options = _.extend({safe: true}, options);                                                                          // 709
                                                                                                                      // 710
  // We expect this function to be called at startup, not from within a method,                                       // 711
  // so we don't interact with the write fence.                                                                       // 712
  var collection = self._getCollection(collectionName);                                                               // 713
  var future = new Future;                                                                                            // 714
  var indexName = collection.ensureIndex(index, options, future.resolver());                                          // 715
  future.wait();                                                                                                      // 716
};                                                                                                                    // 717
MongoConnection.prototype._dropIndex = function (collectionName, index) {                                             // 718
  var self = this;                                                                                                    // 719
                                                                                                                      // 720
  // This function is only used by test code, not within a method, so we don't                                        // 721
  // interact with the write fence.                                                                                   // 722
  var collection = self._getCollection(collectionName);                                                               // 723
  var future = new Future;                                                                                            // 724
  var indexName = collection.dropIndex(index, future.resolver());                                                     // 725
  future.wait();                                                                                                      // 726
};                                                                                                                    // 727
                                                                                                                      // 728
// CURSORS                                                                                                            // 729
                                                                                                                      // 730
// There are several classes which relate to cursors:                                                                 // 731
//                                                                                                                    // 732
// CursorDescription represents the arguments used to construct a cursor:                                             // 733
// collectionName, selector, and (find) options.  Because it is used as a key                                         // 734
// for cursor de-dup, everything in it should either be JSON-stringifiable or                                         // 735
// not affect observeChanges output (eg, options.transform functions are not                                          // 736
// stringifiable but do not affect observeChanges).                                                                   // 737
//                                                                                                                    // 738
// SynchronousCursor is a wrapper around a MongoDB cursor                                                             // 739
// which includes fully-synchronous versions of forEach, etc.                                                         // 740
//                                                                                                                    // 741
// Cursor is the cursor object returned from find(), which implements the                                             // 742
// documented Mongo.Collection cursor API.  It wraps a CursorDescription and a                                        // 743
// SynchronousCursor (lazily: it doesn't contact Mongo until you call a method                                        // 744
// like fetch or forEach on it).                                                                                      // 745
//                                                                                                                    // 746
// ObserveHandle is the "observe handle" returned from observeChanges. It has a                                       // 747
// reference to an ObserveMultiplexer.                                                                                // 748
//                                                                                                                    // 749
// ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a                                      // 750
// single observe driver.                                                                                             // 751
//                                                                                                                    // 752
// There are two "observe drivers" which drive ObserveMultiplexers:                                                   // 753
//   - PollingObserveDriver caches the results of a query and reruns it when                                          // 754
//     necessary.                                                                                                     // 755
//   - OplogObserveDriver follows the Mongo operation log to directly observe                                         // 756
//     database changes.                                                                                              // 757
// Both implementations follow the same simple interface: when you create them,                                       // 758
// they start sending observeChanges callbacks (and a ready() invocation) to                                          // 759
// their ObserveMultiplexer, and you stop them by calling their stop() method.                                        // 760
                                                                                                                      // 761
CursorDescription = function (collectionName, selector, options) {                                                    // 762
  var self = this;                                                                                                    // 763
  self.collectionName = collectionName;                                                                               // 764
  self.selector = Mongo.Collection._rewriteSelector(selector);                                                        // 765
  self.options = options || {};                                                                                       // 766
};                                                                                                                    // 767
                                                                                                                      // 768
Cursor = function (mongo, cursorDescription) {                                                                        // 769
  var self = this;                                                                                                    // 770
                                                                                                                      // 771
  self._mongo = mongo;                                                                                                // 772
  self._cursorDescription = cursorDescription;                                                                        // 773
  self._synchronousCursor = null;                                                                                     // 774
};                                                                                                                    // 775
                                                                                                                      // 776
_.each(['forEach', 'map', 'fetch', 'count'], function (method) {                                                      // 777
  Cursor.prototype[method] = function () {                                                                            // 778
    var self = this;                                                                                                  // 779
                                                                                                                      // 780
    // You can only observe a tailable cursor.                                                                        // 781
    if (self._cursorDescription.options.tailable)                                                                     // 782
      throw new Error("Cannot call " + method + " on a tailable cursor");                                             // 783
                                                                                                                      // 784
    if (!self._synchronousCursor) {                                                                                   // 785
      self._synchronousCursor = self._mongo._createSynchronousCursor(                                                 // 786
        self._cursorDescription, {                                                                                    // 787
          // Make sure that the "self" argument to forEach/map callbacks is the                                       // 788
          // Cursor, not the SynchronousCursor.                                                                       // 789
          selfForIteration: self,                                                                                     // 790
          useTransform: true                                                                                          // 791
        });                                                                                                           // 792
    }                                                                                                                 // 793
                                                                                                                      // 794
    return self._synchronousCursor[method].apply(                                                                     // 795
      self._synchronousCursor, arguments);                                                                            // 796
  };                                                                                                                  // 797
});                                                                                                                   // 798
                                                                                                                      // 799
// Since we don't actually have a "nextObject" interface, there's really no                                           // 800
// reason to have a "rewind" interface.  All it did was make multiple calls                                           // 801
// to fetch/map/forEach return nothing the second time.                                                               // 802
// XXX COMPAT WITH 0.8.1                                                                                              // 803
Cursor.prototype.rewind = function () {                                                                               // 804
};                                                                                                                    // 805
                                                                                                                      // 806
Cursor.prototype.getTransform = function () {                                                                         // 807
  return this._cursorDescription.options.transform;                                                                   // 808
};                                                                                                                    // 809
                                                                                                                      // 810
// When you call Meteor.publish() with a function that returns a Cursor, we need                                      // 811
// to transmute it into the equivalent subscription.  This is the function that                                       // 812
// does that.                                                                                                         // 813
                                                                                                                      // 814
Cursor.prototype._publishCursor = function (sub) {                                                                    // 815
  var self = this;                                                                                                    // 816
  var collection = self._cursorDescription.collectionName;                                                            // 817
  return Mongo.Collection._publishCursor(self, sub, collection);                                                      // 818
};                                                                                                                    // 819
                                                                                                                      // 820
// Used to guarantee that publish functions return at most one cursor per                                             // 821
// collection. Private, because we might later have cursors that include                                              // 822
// documents from multiple collections somehow.                                                                       // 823
Cursor.prototype._getCollectionName = function () {                                                                   // 824
  var self = this;                                                                                                    // 825
  return self._cursorDescription.collectionName;                                                                      // 826
}                                                                                                                     // 827
                                                                                                                      // 828
Cursor.prototype.observe = function (callbacks) {                                                                     // 829
  var self = this;                                                                                                    // 830
  return LocalCollection._observeFromObserveChanges(self, callbacks);                                                 // 831
};                                                                                                                    // 832
                                                                                                                      // 833
Cursor.prototype.observeChanges = function (callbacks) {                                                              // 834
  var self = this;                                                                                                    // 835
  var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks);                                        // 836
  return self._mongo._observeChanges(                                                                                 // 837
    self._cursorDescription, ordered, callbacks);                                                                     // 838
};                                                                                                                    // 839
                                                                                                                      // 840
MongoConnection.prototype._createSynchronousCursor = function(                                                        // 841
    cursorDescription, options) {                                                                                     // 842
  var self = this;                                                                                                    // 843
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');                                                // 844
                                                                                                                      // 845
  var collection = self._getCollection(cursorDescription.collectionName);                                             // 846
  var cursorOptions = cursorDescription.options;                                                                      // 847
  var mongoOptions = {                                                                                                // 848
    sort: cursorOptions.sort,                                                                                         // 849
    limit: cursorOptions.limit,                                                                                       // 850
    skip: cursorOptions.skip                                                                                          // 851
  };                                                                                                                  // 852
                                                                                                                      // 853
  // Do we want a tailable cursor (which only works on capped collections)?                                           // 854
  if (cursorOptions.tailable) {                                                                                       // 855
    // We want a tailable cursor...                                                                                   // 856
    mongoOptions.tailable = true;                                                                                     // 857
    // ... and for the server to wait a bit if any getMore has no data (rather                                        // 858
    // than making us put the relevant sleeps in the client)...                                                       // 859
    mongoOptions.awaitdata = true;                                                                                    // 860
    // ... and to keep querying the server indefinitely rather than just 5 times                                      // 861
    // if there's no more data.                                                                                       // 862
    mongoOptions.numberOfRetries = -1;                                                                                // 863
    // And if this is on the oplog collection and the cursor specifies a 'ts',                                        // 864
    // then set the undocumented oplog replay flag, which does a special scan to                                      // 865
    // find the first document (instead of creating an index on ts). This is a                                        // 866
    // very hard-coded Mongo flag which only works on the oplog collection and                                        // 867
    // only works with the ts field.                                                                                  // 868
    if (cursorDescription.collectionName === OPLOG_COLLECTION &&                                                      // 869
        cursorDescription.selector.ts) {                                                                              // 870
      mongoOptions.oplogReplay = true;                                                                                // 871
    }                                                                                                                 // 872
  }                                                                                                                   // 873
                                                                                                                      // 874
  var dbCursor = collection.find(                                                                                     // 875
    replaceTypes(cursorDescription.selector, replaceMeteorAtomWithMongo),                                             // 876
    cursorOptions.fields, mongoOptions);                                                                              // 877
                                                                                                                      // 878
  return new SynchronousCursor(dbCursor, cursorDescription, options);                                                 // 879
};                                                                                                                    // 880
                                                                                                                      // 881
var SynchronousCursor = function (dbCursor, cursorDescription, options) {                                             // 882
  var self = this;                                                                                                    // 883
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');                                                // 884
                                                                                                                      // 885
  self._dbCursor = dbCursor;                                                                                          // 886
  self._cursorDescription = cursorDescription;                                                                        // 887
  // The "self" argument passed to forEach/map callbacks. If we're wrapped                                            // 888
  // inside a user-visible Cursor, we want to provide the outer cursor!                                               // 889
  self._selfForIteration = options.selfForIteration || self;                                                          // 890
  if (options.useTransform && cursorDescription.options.transform) {                                                  // 891
    self._transform = LocalCollection.wrapTransform(                                                                  // 892
      cursorDescription.options.transform);                                                                           // 893
  } else {                                                                                                            // 894
    self._transform = null;                                                                                           // 895
  }                                                                                                                   // 896
                                                                                                                      // 897
  // Need to specify that the callback is the first argument to nextObject,                                           // 898
  // since otherwise when we try to call it with no args the driver will                                              // 899
  // interpret "undefined" first arg as an options hash and crash.                                                    // 900
  self._synchronousNextObject = Future.wrap(                                                                          // 901
    dbCursor.nextObject.bind(dbCursor), 0);                                                                           // 902
  self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));                                                // 903
  self._visitedIds = new LocalCollection._IdMap;                                                                      // 904
};                                                                                                                    // 905
                                                                                                                      // 906
_.extend(SynchronousCursor.prototype, {                                                                               // 907
  _nextObject: function () {                                                                                          // 908
    var self = this;                                                                                                  // 909
                                                                                                                      // 910
    while (true) {                                                                                                    // 911
      var doc = self._synchronousNextObject().wait();                                                                 // 912
                                                                                                                      // 913
      if (!doc) return null;                                                                                          // 914
      doc = replaceTypes(doc, replaceMongoAtomWithMeteor);                                                            // 915
                                                                                                                      // 916
      if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {                                           // 917
        // Did Mongo give us duplicate documents in the same cursor? If so,                                           // 918
        // ignore this one. (Do this before the transform, since transform might                                      // 919
        // return some unrelated value.) We don't do this for tailable cursors,                                       // 920
        // because we want to maintain O(1) memory usage. And if there isn't _id                                      // 921
        // for some reason (maybe it's the oplog), then we don't do this either.                                      // 922
        // (Be careful to do this for falsey but existing _id, though.)                                               // 923
        if (self._visitedIds.has(doc._id)) continue;                                                                  // 924
        self._visitedIds.set(doc._id, true);                                                                          // 925
      }                                                                                                               // 926
                                                                                                                      // 927
      if (self._transform)                                                                                            // 928
        doc = self._transform(doc);                                                                                   // 929
                                                                                                                      // 930
      return doc;                                                                                                     // 931
    }                                                                                                                 // 932
  },                                                                                                                  // 933
                                                                                                                      // 934
  forEach: function (callback, thisArg) {                                                                             // 935
    var self = this;                                                                                                  // 936
                                                                                                                      // 937
    // Get back to the beginning.                                                                                     // 938
    self._rewind();                                                                                                   // 939
                                                                                                                      // 940
    // We implement the loop ourself instead of using self._dbCursor.each,                                            // 941
    // because "each" will call its callback outside of a fiber which makes it                                        // 942
    // much more complex to make this function synchronous.                                                           // 943
    var index = 0;                                                                                                    // 944
    while (true) {                                                                                                    // 945
      var doc = self._nextObject();                                                                                   // 946
      if (!doc) return;                                                                                               // 947
      callback.call(thisArg, doc, index++, self._selfForIteration);                                                   // 948
    }                                                                                                                 // 949
  },                                                                                                                  // 950
                                                                                                                      // 951
  // XXX Allow overlapping callback executions if callback yields.                                                    // 952
  map: function (callback, thisArg) {                                                                                 // 953
    var self = this;                                                                                                  // 954
    var res = [];                                                                                                     // 955
    self.forEach(function (doc, index) {                                                                              // 956
      res.push(callback.call(thisArg, doc, index, self._selfForIteration));                                           // 957
    });                                                                                                               // 958
    return res;                                                                                                       // 959
  },                                                                                                                  // 960
                                                                                                                      // 961
  _rewind: function () {                                                                                              // 962
    var self = this;                                                                                                  // 963
                                                                                                                      // 964
    // known to be synchronous                                                                                        // 965
    self._dbCursor.rewind();                                                                                          // 966
                                                                                                                      // 967
    self._visitedIds = new LocalCollection._IdMap;                                                                    // 968
  },                                                                                                                  // 969
                                                                                                                      // 970
  // Mostly usable for tailable cursors.                                                                              // 971
  close: function () {                                                                                                // 972
    var self = this;                                                                                                  // 973
                                                                                                                      // 974
    self._dbCursor.close();                                                                                           // 975
  },                                                                                                                  // 976
                                                                                                                      // 977
  fetch: function () {                                                                                                // 978
    var self = this;                                                                                                  // 979
    return self.map(_.identity);                                                                                      // 980
  },                                                                                                                  // 981
                                                                                                                      // 982
  count: function () {                                                                                                // 983
    var self = this;                                                                                                  // 984
    return self._synchronousCount().wait();                                                                           // 985
  },                                                                                                                  // 986
                                                                                                                      // 987
  // This method is NOT wrapped in Cursor.                                                                            // 988
  getRawObjects: function (ordered) {                                                                                 // 989
    var self = this;                                                                                                  // 990
    if (ordered) {                                                                                                    // 991
      return self.fetch();                                                                                            // 992
    } else {                                                                                                          // 993
      var results = new LocalCollection._IdMap;                                                                       // 994
      self.forEach(function (doc) {                                                                                   // 995
        results.set(doc._id, doc);                                                                                    // 996
      });                                                                                                             // 997
      return results;                                                                                                 // 998
    }                                                                                                                 // 999
  }                                                                                                                   // 1000
});                                                                                                                   // 1001
                                                                                                                      // 1002
MongoConnection.prototype.tail = function (cursorDescription, docCallback) {                                          // 1003
  var self = this;                                                                                                    // 1004
  if (!cursorDescription.options.tailable)                                                                            // 1005
    throw new Error("Can only tail a tailable cursor");                                                               // 1006
                                                                                                                      // 1007
  var cursor = self._createSynchronousCursor(cursorDescription);                                                      // 1008
                                                                                                                      // 1009
  var stopped = false;                                                                                                // 1010
  var lastTS = undefined;                                                                                             // 1011
  var loop = function () {                                                                                            // 1012
    while (true) {                                                                                                    // 1013
      if (stopped)                                                                                                    // 1014
        return;                                                                                                       // 1015
      try {                                                                                                           // 1016
        var doc = cursor._nextObject();                                                                               // 1017
      } catch (err) {                                                                                                 // 1018
        // There's no good way to figure out if this was actually an error                                            // 1019
        // from Mongo. Ah well. But either way, we need to retry the cursor                                           // 1020
        // (unless the failure was because the observe got stopped).                                                  // 1021
        doc = null;                                                                                                   // 1022
      }                                                                                                               // 1023
      // Since cursor._nextObject can yield, we need to check again to see if                                         // 1024
      // we've been stopped before calling the callback.                                                              // 1025
      if (stopped)                                                                                                    // 1026
        return;                                                                                                       // 1027
      if (doc) {                                                                                                      // 1028
        // If a tailable cursor contains a "ts" field, use it to recreate the                                         // 1029
        // cursor on error. ("ts" is a standard that Mongo uses internally for                                        // 1030
        // the oplog, and there's a special flag that lets you do binary search                                       // 1031
        // on it instead of needing to use an index.)                                                                 // 1032
        lastTS = doc.ts;                                                                                              // 1033
        docCallback(doc);                                                                                             // 1034
      } else {                                                                                                        // 1035
        var newSelector = _.clone(cursorDescription.selector);                                                        // 1036
        if (lastTS) {                                                                                                 // 1037
          newSelector.ts = {$gt: lastTS};                                                                             // 1038
        }                                                                                                             // 1039
        cursor = self._createSynchronousCursor(new CursorDescription(                                                 // 1040
          cursorDescription.collectionName,                                                                           // 1041
          newSelector,                                                                                                // 1042
          cursorDescription.options));                                                                                // 1043
        // Mongo failover takes many seconds.  Retry in a bit.  (Without this                                         // 1044
        // setTimeout, we peg the CPU at 100% and never notice the actual                                             // 1045
        // failover.                                                                                                  // 1046
        Meteor.setTimeout(loop, 100);                                                                                 // 1047
        break;                                                                                                        // 1048
      }                                                                                                               // 1049
    }                                                                                                                 // 1050
  };                                                                                                                  // 1051
                                                                                                                      // 1052
  Meteor.defer(loop);                                                                                                 // 1053
                                                                                                                      // 1054
  return {                                                                                                            // 1055
    stop: function () {                                                                                               // 1056
      stopped = true;                                                                                                 // 1057
      cursor.close();                                                                                                 // 1058
    }                                                                                                                 // 1059
  };                                                                                                                  // 1060
};                                                                                                                    // 1061
                                                                                                                      // 1062
MongoConnection.prototype._observeChanges = function (                                                                // 1063
    cursorDescription, ordered, callbacks) {                                                                          // 1064
  var self = this;                                                                                                    // 1065
                                                                                                                      // 1066
  if (cursorDescription.options.tailable) {                                                                           // 1067
    return self._observeChangesTailable(cursorDescription, ordered, callbacks);                                       // 1068
  }                                                                                                                   // 1069
                                                                                                                      // 1070
  // You may not filter out _id when observing changes, because the id is a core                                      // 1071
  // part of the observeChanges API.                                                                                  // 1072
  if (cursorDescription.options.fields &&                                                                             // 1073
      (cursorDescription.options.fields._id === 0 ||                                                                  // 1074
       cursorDescription.options.fields._id === false)) {                                                             // 1075
    throw Error("You may not observe a cursor with {fields: {_id: 0}}");                                              // 1076
  }                                                                                                                   // 1077
                                                                                                                      // 1078
  var observeKey = JSON.stringify(                                                                                    // 1079
    _.extend({ordered: ordered}, cursorDescription));                                                                 // 1080
                                                                                                                      // 1081
  var multiplexer, observeDriver;                                                                                     // 1082
  var firstHandle = false;                                                                                            // 1083
                                                                                                                      // 1084
  // Find a matching ObserveMultiplexer, or create a new one. This next block is                                      // 1085
  // guaranteed to not yield (and it doesn't call anything that can observe a                                         // 1086
  // new query), so no other calls to this function can interleave with it.                                           // 1087
  Meteor._noYieldsAllowed(function () {                                                                               // 1088
    if (_.has(self._observeMultiplexers, observeKey)) {                                                               // 1089
      multiplexer = self._observeMultiplexers[observeKey];                                                            // 1090
    } else {                                                                                                          // 1091
      firstHandle = true;                                                                                             // 1092
      // Create a new ObserveMultiplexer.                                                                             // 1093
      multiplexer = new ObserveMultiplexer({                                                                          // 1094
        ordered: ordered,                                                                                             // 1095
        onStop: function () {                                                                                         // 1096
          delete self._observeMultiplexers[observeKey];                                                               // 1097
          observeDriver.stop();                                                                                       // 1098
        }                                                                                                             // 1099
      });                                                                                                             // 1100
      self._observeMultiplexers[observeKey] = multiplexer;                                                            // 1101
    }                                                                                                                 // 1102
  });                                                                                                                 // 1103
                                                                                                                      // 1104
  var observeHandle = new ObserveHandle(multiplexer, callbacks);                                                      // 1105
                                                                                                                      // 1106
  if (firstHandle) {                                                                                                  // 1107
    var matcher, sorter;                                                                                              // 1108
    var canUseOplog = _.all([                                                                                         // 1109
      function () {                                                                                                   // 1110
        // At a bare minimum, using the oplog requires us to have an oplog, to                                        // 1111
        // want unordered callbacks, and to not want a callback on the polls                                          // 1112
        // that won't happen.                                                                                         // 1113
        return self._oplogHandle && !ordered &&                                                                       // 1114
          !callbacks._testOnlyPollCallback;                                                                           // 1115
      }, function () {                                                                                                // 1116
        // We need to be able to compile the selector. Fall back to polling for                                       // 1117
        // some newfangled $selector that minimongo doesn't support yet.                                              // 1118
        try {                                                                                                         // 1119
          matcher = new Minimongo.Matcher(cursorDescription.selector);                                                // 1120
          return true;                                                                                                // 1121
        } catch (e) {                                                                                                 // 1122
          // XXX make all compilation errors MinimongoError or something                                              // 1123
          //     so that this doesn't ignore unrelated exceptions                                                     // 1124
          return false;                                                                                               // 1125
        }                                                                                                             // 1126
      }, function () {                                                                                                // 1127
        // ... and the selector itself needs to support oplog.                                                        // 1128
        return OplogObserveDriver.cursorSupported(cursorDescription, matcher);                                        // 1129
      }, function () {                                                                                                // 1130
        // And we need to be able to compile the sort, if any.  eg, can't be                                          // 1131
        // {$natural: 1}.                                                                                             // 1132
        if (!cursorDescription.options.sort)                                                                          // 1133
          return true;                                                                                                // 1134
        try {                                                                                                         // 1135
          sorter = new Minimongo.Sorter(cursorDescription.options.sort,                                               // 1136
                                        { matcher: matcher });                                                        // 1137
          return true;                                                                                                // 1138
        } catch (e) {                                                                                                 // 1139
          // XXX make all compilation errors MinimongoError or something                                              // 1140
          //     so that this doesn't ignore unrelated exceptions                                                     // 1141
          return false;                                                                                               // 1142
        }                                                                                                             // 1143
      }], function (f) { return f(); });  // invoke each function                                                     // 1144
                                                                                                                      // 1145
    var driverClass = canUseOplog ? OplogObserveDriver : PollingObserveDriver;                                        // 1146
    observeDriver = new driverClass({                                                                                 // 1147
      cursorDescription: cursorDescription,                                                                           // 1148
      mongoHandle: self,                                                                                              // 1149
      multiplexer: multiplexer,                                                                                       // 1150
      ordered: ordered,                                                                                               // 1151
      matcher: matcher,  // ignored by polling                                                                        // 1152
      sorter: sorter,  // ignored by polling                                                                          // 1153
      _testOnlyPollCallback: callbacks._testOnlyPollCallback                                                          // 1154
    });                                                                                                               // 1155
                                                                                                                      // 1156
    // This field is only set for use in tests.                                                                       // 1157
    multiplexer._observeDriver = observeDriver;                                                                       // 1158
  }                                                                                                                   // 1159
                                                                                                                      // 1160
  // Blocks until the initial adds have been sent.                                                                    // 1161
  multiplexer.addHandleAndSendInitialAdds(observeHandle);                                                             // 1162
                                                                                                                      // 1163
  return observeHandle;                                                                                               // 1164
};                                                                                                                    // 1165
                                                                                                                      // 1166
// Listen for the invalidation messages that will trigger us to poll the                                              // 1167
// database for changes. If this selector specifies specific IDs, specify them                                        // 1168
// here, so that updates to different specific IDs don't cause us to poll.                                            // 1169
// listenCallback is the same kind of (notification, complete) callback passed                                        // 1170
// to InvalidationCrossbar.listen.                                                                                    // 1171
                                                                                                                      // 1172
listenAll = function (cursorDescription, listenCallback) {                                                            // 1173
  var listeners = [];                                                                                                 // 1174
  forEachTrigger(cursorDescription, function (trigger) {                                                              // 1175
    listeners.push(DDPServer._InvalidationCrossbar.listen(                                                            // 1176
      trigger, listenCallback));                                                                                      // 1177
  });                                                                                                                 // 1178
                                                                                                                      // 1179
  return {                                                                                                            // 1180
    stop: function () {                                                                                               // 1181
      _.each(listeners, function (listener) {                                                                         // 1182
        listener.stop();                                                                                              // 1183
      });                                                                                                             // 1184
    }                                                                                                                 // 1185
  };                                                                                                                  // 1186
};                                                                                                                    // 1187
                                                                                                                      // 1188
forEachTrigger = function (cursorDescription, triggerCallback) {                                                      // 1189
  var key = {collection: cursorDescription.collectionName};                                                           // 1190
  var specificIds = LocalCollection._idsMatchedBySelector(                                                            // 1191
    cursorDescription.selector);                                                                                      // 1192
  if (specificIds) {                                                                                                  // 1193
    _.each(specificIds, function (id) {                                                                               // 1194
      triggerCallback(_.extend({id: id}, key));                                                                       // 1195
    });                                                                                                               // 1196
    triggerCallback(_.extend({dropCollection: true, id: null}, key));                                                 // 1197
  } else {                                                                                                            // 1198
    triggerCallback(key);                                                                                             // 1199
  }                                                                                                                   // 1200
};                                                                                                                    // 1201
                                                                                                                      // 1202
// observeChanges for tailable cursors on capped collections.                                                         // 1203
//                                                                                                                    // 1204
// Some differences from normal cursors:                                                                              // 1205
//   - Will never produce anything other than 'added' or 'addedBefore'. If you                                        // 1206
//     do update a document that has already been produced, this will not notice                                      // 1207
//     it.                                                                                                            // 1208
//   - If you disconnect and reconnect from Mongo, it will essentially restart                                        // 1209
//     the query, which will lead to duplicate results. This is pretty bad,                                           // 1210
//     but if you include a field called 'ts' which is inserted as                                                    // 1211
//     new MongoInternals.MongoTimestamp(0, 0) (which is initialized to the                                           // 1212
//     current Mongo-style timestamp), we'll be able to find the place to                                             // 1213
//     restart properly. (This field is specifically understood by Mongo with an                                      // 1214
//     optimization which allows it to find the right place to start without                                          // 1215
//     an index on ts. It's how the oplog works.)                                                                     // 1216
//   - No callbacks are triggered synchronously with the call (there's no                                             // 1217
//     differentiation between "initial data" and "later changes"; everything                                         // 1218
//     that matches the query gets sent asynchronously).                                                              // 1219
//   - De-duplication is not implemented.                                                                             // 1220
//   - Does not yet interact with the write fence. Probably, this should work by                                      // 1221
//     ignoring removes (which don't work on capped collections) and updates                                          // 1222
//     (which don't affect tailable cursors), and just keeping track of the ID                                        // 1223
//     of the inserted object, and closing the write fence once you get to that                                       // 1224
//     ID (or timestamp?).  This doesn't work well if the document doesn't match                                      // 1225
//     the query, though.  On the other hand, the write fence can close                                               // 1226
//     immediately if it does not match the query. So if we trust minimongo                                           // 1227
//     enough to accurately evaluate the query against the write fence, we                                            // 1228
//     should be able to do this...  Of course, minimongo doesn't even support                                        // 1229
//     Mongo Timestamps yet.                                                                                          // 1230
MongoConnection.prototype._observeChangesTailable = function (                                                        // 1231
    cursorDescription, ordered, callbacks) {                                                                          // 1232
  var self = this;                                                                                                    // 1233
                                                                                                                      // 1234
  // Tailable cursors only ever call added/addedBefore callbacks, so it's an                                          // 1235
  // error if you didn't provide them.                                                                                // 1236
  if ((ordered && !callbacks.addedBefore) ||                                                                          // 1237
      (!ordered && !callbacks.added)) {                                                                               // 1238
    throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered")                                         // 1239
                    + " tailable cursor without a "                                                                   // 1240
                    + (ordered ? "addedBefore" : "added") + " callback");                                             // 1241
  }                                                                                                                   // 1242
                                                                                                                      // 1243
  return self.tail(cursorDescription, function (doc) {                                                                // 1244
    var id = doc._id;                                                                                                 // 1245
    delete doc._id;                                                                                                   // 1246
    // The ts is an implementation detail. Hide it.                                                                   // 1247
    delete doc.ts;                                                                                                    // 1248
    if (ordered) {                                                                                                    // 1249
      callbacks.addedBefore(id, doc, null);                                                                           // 1250
    } else {                                                                                                          // 1251
      callbacks.added(id, doc);                                                                                       // 1252
    }                                                                                                                 // 1253
  });                                                                                                                 // 1254
};                                                                                                                    // 1255
                                                                                                                      // 1256
// XXX We probably need to find a better way to expose this. Right now                                                // 1257
// it's only used by tests, but in fact you need it in normal                                                         // 1258
// operation to interact with capped collections.                                                                     // 1259
MongoInternals.MongoTimestamp = MongoDB.Timestamp;                                                                    // 1260
                                                                                                                      // 1261
MongoInternals.Connection = MongoConnection;                                                                          // 1262
MongoInternals.NpmModule = MongoDB;                                                                                   // 1263
                                                                                                                      // 1264
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/oplog_tailing.js                                                                                    //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var Future = Npm.require('fibers/future');                                                                            // 1
                                                                                                                      // 2
OPLOG_COLLECTION = 'oplog.rs';                                                                                        // 3
                                                                                                                      // 4
// Like Perl's quotemeta: quotes all regexp metacharacters. See                                                       // 5
//   https://github.com/substack/quotemeta/blob/master/index.js                                                       // 6
// XXX this is duplicated with accounts_server.js                                                                     // 7
var quotemeta = function (str) {                                                                                      // 8
    return String(str).replace(/(\W)/g, '\\$1');                                                                      // 9
};                                                                                                                    // 10
                                                                                                                      // 11
var showTS = function (ts) {                                                                                          // 12
  return "Timestamp(" + ts.getHighBits() + ", " + ts.getLowBits() + ")";                                              // 13
};                                                                                                                    // 14
                                                                                                                      // 15
idForOp = function (op) {                                                                                             // 16
  if (op.op === 'd')                                                                                                  // 17
    return op.o._id;                                                                                                  // 18
  else if (op.op === 'i')                                                                                             // 19
    return op.o._id;                                                                                                  // 20
  else if (op.op === 'u')                                                                                             // 21
    return op.o2._id;                                                                                                 // 22
  else if (op.op === 'c')                                                                                             // 23
    throw Error("Operator 'c' doesn't supply an object with id: " +                                                   // 24
                EJSON.stringify(op));                                                                                 // 25
  else                                                                                                                // 26
    throw Error("Unknown op: " + EJSON.stringify(op));                                                                // 27
};                                                                                                                    // 28
                                                                                                                      // 29
OplogHandle = function (oplogUrl, dbName) {                                                                           // 30
  var self = this;                                                                                                    // 31
  self._oplogUrl = oplogUrl;                                                                                          // 32
  self._dbName = dbName;                                                                                              // 33
                                                                                                                      // 34
  self._oplogLastEntryConnection = null;                                                                              // 35
  self._oplogTailConnection = null;                                                                                   // 36
  self._stopped = false;                                                                                              // 37
  self._tailHandle = null;                                                                                            // 38
  self._readyFuture = new Future();                                                                                   // 39
  self._crossbar = new DDPServer._Crossbar({                                                                          // 40
    factPackage: "mongo-livedata", factName: "oplog-watchers"                                                         // 41
  });                                                                                                                 // 42
  self._lastProcessedTS = null;                                                                                       // 43
  self._baseOplogSelector = {                                                                                         // 44
    ns: new RegExp('^' + quotemeta(self._dbName) + '\\.'),                                                            // 45
    $or: [                                                                                                            // 46
      { op: {$in: ['i', 'u', 'd']} },                                                                                 // 47
      // If it is not db.collection.drop(), ignore it                                                                 // 48
      { op: 'c', 'o.drop': { $exists: true } }]                                                                       // 49
  };                                                                                                                  // 50
  // XXX doc                                                                                                          // 51
  self._catchingUpFutures = [];                                                                                       // 52
                                                                                                                      // 53
  self._startTailing();                                                                                               // 54
};                                                                                                                    // 55
                                                                                                                      // 56
_.extend(OplogHandle.prototype, {                                                                                     // 57
  stop: function () {                                                                                                 // 58
    var self = this;                                                                                                  // 59
    if (self._stopped)                                                                                                // 60
      return;                                                                                                         // 61
    self._stopped = true;                                                                                             // 62
    if (self._tailHandle)                                                                                             // 63
      self._tailHandle.stop();                                                                                        // 64
    // XXX should close connections too                                                                               // 65
  },                                                                                                                  // 66
  onOplogEntry: function (trigger, callback) {                                                                        // 67
    var self = this;                                                                                                  // 68
    if (self._stopped)                                                                                                // 69
      throw new Error("Called onOplogEntry on stopped handle!");                                                      // 70
                                                                                                                      // 71
    // Calling onOplogEntry requires us to wait for the tailing to be ready.                                          // 72
    self._readyFuture.wait();                                                                                         // 73
                                                                                                                      // 74
    var originalCallback = callback;                                                                                  // 75
    callback = Meteor.bindEnvironment(function (notification) {                                                       // 76
      // XXX can we avoid this clone by making oplog.js careful?                                                      // 77
      originalCallback(EJSON.clone(notification));                                                                    // 78
    }, function (err) {                                                                                               // 79
      Meteor._debug("Error in oplog callback", err.stack);                                                            // 80
    });                                                                                                               // 81
    var listenHandle = self._crossbar.listen(trigger, callback);                                                      // 82
    return {                                                                                                          // 83
      stop: function () {                                                                                             // 84
        listenHandle.stop();                                                                                          // 85
      }                                                                                                               // 86
    };                                                                                                                // 87
  },                                                                                                                  // 88
  // Calls `callback` once the oplog has been processed up to a point that is                                         // 89
  // roughly "now": specifically, once we've processed all ops that are                                               // 90
  // currently visible.                                                                                               // 91
  // XXX become convinced that this is actually safe even if oplogConnection                                          // 92
  // is some kind of pool                                                                                             // 93
  waitUntilCaughtUp: function () {                                                                                    // 94
    var self = this;                                                                                                  // 95
    if (self._stopped)                                                                                                // 96
      throw new Error("Called waitUntilCaughtUp on stopped handle!");                                                 // 97
                                                                                                                      // 98
    // Calling waitUntilCaughtUp requries us to wait for the oplog connection to                                      // 99
    // be ready.                                                                                                      // 100
    self._readyFuture.wait();                                                                                         // 101
                                                                                                                      // 102
    while (!self._stopped) {                                                                                          // 103
      // We need to make the selector at least as restrictive as the actual                                           // 104
      // tailing selector (ie, we need to specify the DB name) or else we might                                       // 105
      // find a TS that won't show up in the actual tail stream.                                                      // 106
      try {                                                                                                           // 107
        var lastEntry = self._oplogLastEntryConnection.findOne(                                                       // 108
          OPLOG_COLLECTION, self._baseOplogSelector,                                                                  // 109
          {fields: {ts: 1}, sort: {$natural: -1}});                                                                   // 110
        break;                                                                                                        // 111
      } catch (e) {                                                                                                   // 112
        // During failover (eg) if we get an exception we should log and retry                                        // 113
        // instead of crashing.                                                                                       // 114
        Meteor._debug("Got exception while reading last entry: " + e);                                                // 115
        Meteor._sleepForMs(100);                                                                                      // 116
      }                                                                                                               // 117
    }                                                                                                                 // 118
                                                                                                                      // 119
    if (self._stopped)                                                                                                // 120
      return;                                                                                                         // 121
                                                                                                                      // 122
    if (!lastEntry) {                                                                                                 // 123
      // Really, nothing in the oplog? Well, we've processed everything.                                              // 124
      return;                                                                                                         // 125
    }                                                                                                                 // 126
                                                                                                                      // 127
    var ts = lastEntry.ts;                                                                                            // 128
    if (!ts)                                                                                                          // 129
      throw Error("oplog entry without ts: " + EJSON.stringify(lastEntry));                                           // 130
                                                                                                                      // 131
    if (self._lastProcessedTS && ts.lessThanOrEqual(self._lastProcessedTS)) {                                         // 132
      // We've already caught up to here.                                                                             // 133
      return;                                                                                                         // 134
    }                                                                                                                 // 135
                                                                                                                      // 136
                                                                                                                      // 137
    // Insert the future into our list. Almost always, this will be at the end,                                       // 138
    // but it's conceivable that if we fail over from one primary to another,                                         // 139
    // the oplog entries we see will go backwards.                                                                    // 140
    var insertAfter = self._catchingUpFutures.length;                                                                 // 141
    while (insertAfter - 1 > 0                                                                                        // 142
           && self._catchingUpFutures[insertAfter - 1].ts.greaterThan(ts)) {                                          // 143
      insertAfter--;                                                                                                  // 144
    }                                                                                                                 // 145
    var f = new Future;                                                                                               // 146
    self._catchingUpFutures.splice(insertAfter, 0, {ts: ts, future: f});                                              // 147
    f.wait();                                                                                                         // 148
  },                                                                                                                  // 149
  _startTailing: function () {                                                                                        // 150
    var self = this;                                                                                                  // 151
    // First, make sure that we're talking to the local database.                                                     // 152
    var mongodbUri = Npm.require('mongodb-uri');                                                                      // 153
    if (mongodbUri.parse(self._oplogUrl).database !== 'local') {                                                      // 154
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " +                                        // 155
                  "a Mongo replica set");                                                                             // 156
    }                                                                                                                 // 157
                                                                                                                      // 158
    // We make two separate connections to Mongo. The Node Mongo driver                                               // 159
    // implements a naive round-robin connection pool: each "connection" is a                                         // 160
    // pool of several (5 by default) TCP connections, and each request is                                            // 161
    // rotated through the pools. Tailable cursor queries block on the server                                         // 162
    // until there is some data to return (or until a few seconds have                                                // 163
    // passed). So if the connection pool used for tailing cursors is the same                                        // 164
    // pool used for other queries, the other queries will be delayed by seconds                                      // 165
    // 1/5 of the time.                                                                                               // 166
    //                                                                                                                // 167
    // The tail connection will only ever be running a single tail command, so                                        // 168
    // it only needs to make one underlying TCP connection.                                                           // 169
    self._oplogTailConnection = new MongoConnection(                                                                  // 170
      self._oplogUrl, {poolSize: 1});                                                                                 // 171
    // XXX better docs, but: it's to get monotonic results                                                            // 172
    // XXX is it safe to say "if there's an in flight query, just use its                                             // 173
    //     results"? I don't think so but should consider that                                                        // 174
    self._oplogLastEntryConnection = new MongoConnection(                                                             // 175
      self._oplogUrl, {poolSize: 1});                                                                                 // 176
                                                                                                                      // 177
    // Now, make sure that there actually is a repl set here. If not, oplog                                           // 178
    // tailing won't ever find anything!                                                                              // 179
    var f = new Future;                                                                                               // 180
    self._oplogLastEntryConnection.db.admin().command(                                                                // 181
      { ismaster: 1 }, f.resolver());                                                                                 // 182
    var isMasterDoc = f.wait();                                                                                       // 183
    if (!(isMasterDoc && isMasterDoc.documents && isMasterDoc.documents[0] &&                                         // 184
          isMasterDoc.documents[0].setName)) {                                                                        // 185
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " +                                        // 186
                  "a Mongo replica set");                                                                             // 187
    }                                                                                                                 // 188
                                                                                                                      // 189
    // Find the last oplog entry.                                                                                     // 190
    var lastOplogEntry = self._oplogLastEntryConnection.findOne(                                                      // 191
      OPLOG_COLLECTION, {}, {sort: {$natural: -1}, fields: {ts: 1}});                                                 // 192
                                                                                                                      // 193
    var oplogSelector = _.clone(self._baseOplogSelector);                                                             // 194
    if (lastOplogEntry) {                                                                                             // 195
      // Start after the last entry that currently exists.                                                            // 196
      oplogSelector.ts = {$gt: lastOplogEntry.ts};                                                                    // 197
      // If there are any calls to callWhenProcessedLatest before any other                                           // 198
      // oplog entries show up, allow callWhenProcessedLatest to call its                                             // 199
      // callback immediately.                                                                                        // 200
      self._lastProcessedTS = lastOplogEntry.ts;                                                                      // 201
    }                                                                                                                 // 202
                                                                                                                      // 203
    var cursorDescription = new CursorDescription(                                                                    // 204
      OPLOG_COLLECTION, oplogSelector, {tailable: true});                                                             // 205
                                                                                                                      // 206
    self._tailHandle = self._oplogTailConnection.tail(                                                                // 207
      cursorDescription, function (doc) {                                                                             // 208
        if (!(doc.ns && doc.ns.length > self._dbName.length + 1 &&                                                    // 209
              doc.ns.substr(0, self._dbName.length + 1) ===                                                           // 210
              (self._dbName + '.'))) {                                                                                // 211
          throw new Error("Unexpected ns");                                                                           // 212
        }                                                                                                             // 213
                                                                                                                      // 214
        var trigger = {collection: doc.ns.substr(self._dbName.length + 1),                                            // 215
                       dropCollection: false,                                                                         // 216
                       op: doc};                                                                                      // 217
                                                                                                                      // 218
        // Is it a special command and the collection name is hidden somewhere                                        // 219
        // in operator?                                                                                               // 220
        if (trigger.collection === "$cmd") {                                                                          // 221
          trigger.collection = doc.o.drop;                                                                            // 222
          trigger.dropCollection = true;                                                                              // 223
          trigger.id = null;                                                                                          // 224
        } else {                                                                                                      // 225
          // All other ops have an id.                                                                                // 226
          trigger.id = idForOp(doc);                                                                                  // 227
        }                                                                                                             // 228
                                                                                                                      // 229
        self._crossbar.fire(trigger);                                                                                 // 230
                                                                                                                      // 231
        // Now that we've processed this operation, process pending sequencers.                                       // 232
        if (!doc.ts)                                                                                                  // 233
          throw Error("oplog entry without ts: " + EJSON.stringify(doc));                                             // 234
        self._lastProcessedTS = doc.ts;                                                                               // 235
        while (!_.isEmpty(self._catchingUpFutures)                                                                    // 236
               && self._catchingUpFutures[0].ts.lessThanOrEqual(                                                      // 237
                 self._lastProcessedTS)) {                                                                            // 238
          var sequencer = self._catchingUpFutures.shift();                                                            // 239
          sequencer.future.return();                                                                                  // 240
        }                                                                                                             // 241
      });                                                                                                             // 242
    self._readyFuture.return();                                                                                       // 243
  }                                                                                                                   // 244
});                                                                                                                   // 245
                                                                                                                      // 246
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/observe_multiplex.js                                                                                //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var Future = Npm.require('fibers/future');                                                                            // 1
                                                                                                                      // 2
ObserveMultiplexer = function (options) {                                                                             // 3
  var self = this;                                                                                                    // 4
                                                                                                                      // 5
  if (!options || !_.has(options, 'ordered'))                                                                         // 6
    throw Error("must specified ordered");                                                                            // 7
                                                                                                                      // 8
  Package.facts && Package.facts.Facts.incrementServerFact(                                                           // 9
    "mongo-livedata", "observe-multiplexers", 1);                                                                     // 10
                                                                                                                      // 11
  self._ordered = options.ordered;                                                                                    // 12
  self._onStop = options.onStop || function () {};                                                                    // 13
  self._queue = new Meteor._SynchronousQueue();                                                                       // 14
  self._handles = {};                                                                                                 // 15
  self._readyFuture = new Future;                                                                                     // 16
  self._cache = new LocalCollection._CachingChangeObserver({                                                          // 17
    ordered: options.ordered});                                                                                       // 18
  // Number of addHandleAndSendInitialAdds tasks scheduled but not yet                                                // 19
  // running. removeHandle uses this to know if it's time to call the onStop                                          // 20
  // callback.                                                                                                        // 21
  self._addHandleTasksScheduledButNotPerformed = 0;                                                                   // 22
                                                                                                                      // 23
  _.each(self.callbackNames(), function (callbackName) {                                                              // 24
    self[callbackName] = function (/* ... */) {                                                                       // 25
      self._applyCallback(callbackName, _.toArray(arguments));                                                        // 26
    };                                                                                                                // 27
  });                                                                                                                 // 28
};                                                                                                                    // 29
                                                                                                                      // 30
_.extend(ObserveMultiplexer.prototype, {                                                                              // 31
  addHandleAndSendInitialAdds: function (handle) {                                                                    // 32
    var self = this;                                                                                                  // 33
                                                                                                                      // 34
    // Check this before calling runTask (even though runTask does the same                                           // 35
    // check) so that we don't leak an ObserveMultiplexer on error by                                                 // 36
    // incrementing _addHandleTasksScheduledButNotPerformed and never                                                 // 37
    // decrementing it.                                                                                               // 38
    if (!self._queue.safeToRunTask())                                                                                 // 39
      throw new Error(                                                                                                // 40
        "Can't call observeChanges from an observe callback on the same query");                                      // 41
    ++self._addHandleTasksScheduledButNotPerformed;                                                                   // 42
                                                                                                                      // 43
    Package.facts && Package.facts.Facts.incrementServerFact(                                                         // 44
      "mongo-livedata", "observe-handles", 1);                                                                        // 45
                                                                                                                      // 46
    self._queue.runTask(function () {                                                                                 // 47
      self._handles[handle._id] = handle;                                                                             // 48
      // Send out whatever adds we have so far (whether or not we the                                                 // 49
      // multiplexer is ready).                                                                                       // 50
      self._sendAdds(handle);                                                                                         // 51
      --self._addHandleTasksScheduledButNotPerformed;                                                                 // 52
    });                                                                                                               // 53
    // *outside* the task, since otherwise we'd deadlock                                                              // 54
    self._readyFuture.wait();                                                                                         // 55
  },                                                                                                                  // 56
                                                                                                                      // 57
  // Remove an observe handle. If it was the last observe handle, call the                                            // 58
  // onStop callback; you cannot add any more observe handles after this.                                             // 59
  //                                                                                                                  // 60
  // This is not synchronized with polls and handle additions: this means that                                        // 61
  // you can safely call it from within an observe callback, but it also means                                        // 62
  // that we have to be careful when we iterate over _handles.                                                        // 63
  removeHandle: function (id) {                                                                                       // 64
    var self = this;                                                                                                  // 65
                                                                                                                      // 66
    // This should not be possible: you can only call removeHandle by having                                          // 67
    // access to the ObserveHandle, which isn't returned to user code until the                                       // 68
    // multiplex is ready.                                                                                            // 69
    if (!self._ready())                                                                                               // 70
      throw new Error("Can't remove handles until the multiplex is ready");                                           // 71
                                                                                                                      // 72
    delete self._handles[id];                                                                                         // 73
                                                                                                                      // 74
    Package.facts && Package.facts.Facts.incrementServerFact(                                                         // 75
      "mongo-livedata", "observe-handles", -1);                                                                       // 76
                                                                                                                      // 77
    if (_.isEmpty(self._handles) &&                                                                                   // 78
        self._addHandleTasksScheduledButNotPerformed === 0) {                                                         // 79
      self._stop();                                                                                                   // 80
    }                                                                                                                 // 81
  },                                                                                                                  // 82
  _stop: function () {                                                                                                // 83
    var self = this;                                                                                                  // 84
    // It shouldn't be possible for us to stop when all our handles still                                             // 85
    // haven't been returned from observeChanges!                                                                     // 86
    if (!self._ready())                                                                                               // 87
      throw Error("surprising _stop: not ready");                                                                     // 88
                                                                                                                      // 89
    // Call stop callback (which kills the underlying process which sends us                                          // 90
    // callbacks and removes us from the connection's dictionary).                                                    // 91
    self._onStop();                                                                                                   // 92
    Package.facts && Package.facts.Facts.incrementServerFact(                                                         // 93
      "mongo-livedata", "observe-multiplexers", -1);                                                                  // 94
                                                                                                                      // 95
    // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop                                        // 96
    // callback should make our connection forget about us).                                                          // 97
    self._handles = null;                                                                                             // 98
  },                                                                                                                  // 99
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding                                       // 100
  // adds have been processed. Does not block.                                                                        // 101
  ready: function () {                                                                                                // 102
    var self = this;                                                                                                  // 103
    self._queue.queueTask(function () {                                                                               // 104
      if (self._ready())                                                                                              // 105
        throw Error("can't make ObserveMultiplex ready twice!");                                                      // 106
      self._readyFuture.return();                                                                                     // 107
    });                                                                                                               // 108
  },                                                                                                                  // 109
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"                                        // 110
  // and observe callbacks which came before this call have been propagated to                                        // 111
  // all handles. "ready" must have already been called on this multiplexer.                                          // 112
  onFlush: function (cb) {                                                                                            // 113
    var self = this;                                                                                                  // 114
    self._queue.queueTask(function () {                                                                               // 115
      if (!self._ready())                                                                                             // 116
        throw Error("only call onFlush on a multiplexer that will be ready");                                         // 117
      cb();                                                                                                           // 118
    });                                                                                                               // 119
  },                                                                                                                  // 120
  callbackNames: function () {                                                                                        // 121
    var self = this;                                                                                                  // 122
    if (self._ordered)                                                                                                // 123
      return ["addedBefore", "changed", "movedBefore", "removed"];                                                    // 124
    else                                                                                                              // 125
      return ["added", "changed", "removed"];                                                                         // 126
  },                                                                                                                  // 127
  _ready: function () {                                                                                               // 128
    return this._readyFuture.isResolved();                                                                            // 129
  },                                                                                                                  // 130
  _applyCallback: function (callbackName, args) {                                                                     // 131
    var self = this;                                                                                                  // 132
    self._queue.queueTask(function () {                                                                               // 133
      // If we stopped in the meantime, do nothing.                                                                   // 134
      if (!self._handles)                                                                                             // 135
        return;                                                                                                       // 136
                                                                                                                      // 137
      // First, apply the change to the cache.                                                                        // 138
      // XXX We could make applyChange callbacks promise not to hang on to any                                        // 139
      // state from their arguments (assuming that their supplied callbacks                                           // 140
      // don't) and skip this clone. Currently 'changed' hangs on to state                                            // 141
      // though.                                                                                                      // 142
      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args));                                           // 143
                                                                                                                      // 144
      // If we haven't finished the initial adds, then we should only be getting                                      // 145
      // adds.                                                                                                        // 146
      if (!self._ready() &&                                                                                           // 147
          (callbackName !== 'added' && callbackName !== 'addedBefore')) {                                             // 148
        throw new Error("Got " + callbackName + " during initial adds");                                              // 149
      }                                                                                                               // 150
                                                                                                                      // 151
      // Now multiplex the callbacks out to all observe handles. It's OK if                                           // 152
      // these calls yield; since we're inside a task, no other use of our queue                                      // 153
      // can continue until these are done. (But we do have to be careful to not                                      // 154
      // use a handle that got removed, because removeHandle does not use the                                         // 155
      // queue; thus, we iterate over an array of keys that we control.)                                              // 156
      _.each(_.keys(self._handles), function (handleId) {                                                             // 157
        var handle = self._handles && self._handles[handleId];                                                        // 158
        if (!handle)                                                                                                  // 159
          return;                                                                                                     // 160
        var callback = handle['_' + callbackName];                                                                    // 161
        // clone arguments so that callbacks can mutate their arguments                                               // 162
        callback && callback.apply(null, EJSON.clone(args));                                                          // 163
      });                                                                                                             // 164
    });                                                                                                               // 165
  },                                                                                                                  // 166
                                                                                                                      // 167
  // Sends initial adds to a handle. It should only be called from within a task                                      // 168
  // (the task that is processing the addHandleAndSendInitialAdds call). It                                           // 169
  // synchronously invokes the handle's added or addedBefore; there's no need to                                      // 170
  // flush the queue afterwards to ensure that the callbacks get out.                                                 // 171
  _sendAdds: function (handle) {                                                                                      // 172
    var self = this;                                                                                                  // 173
    if (self._queue.safeToRunTask())                                                                                  // 174
      throw Error("_sendAdds may only be called from within a task!");                                                // 175
    var add = self._ordered ? handle._addedBefore : handle._added;                                                    // 176
    if (!add)                                                                                                         // 177
      return;                                                                                                         // 178
    // note: docs may be an _IdMap or an OrderedDict                                                                  // 179
    self._cache.docs.forEach(function (doc, id) {                                                                     // 180
      if (!_.has(self._handles, handle._id))                                                                          // 181
        throw Error("handle got removed before sending initial adds!");                                               // 182
      var fields = EJSON.clone(doc);                                                                                  // 183
      delete fields._id;                                                                                              // 184
      if (self._ordered)                                                                                              // 185
        add(id, fields, null); // we're going in order, so add at end                                                 // 186
      else                                                                                                            // 187
        add(id, fields);                                                                                              // 188
    });                                                                                                               // 189
  }                                                                                                                   // 190
});                                                                                                                   // 191
                                                                                                                      // 192
                                                                                                                      // 193
var nextObserveHandleId = 1;                                                                                          // 194
ObserveHandle = function (multiplexer, callbacks) {                                                                   // 195
  var self = this;                                                                                                    // 196
  // The end user is only supposed to call stop().  The other fields are                                              // 197
  // accessible to the multiplexer, though.                                                                           // 198
  self._multiplexer = multiplexer;                                                                                    // 199
  _.each(multiplexer.callbackNames(), function (name) {                                                               // 200
    if (callbacks[name]) {                                                                                            // 201
      self['_' + name] = callbacks[name];                                                                             // 202
    } else if (name === "addedBefore" && callbacks.added) {                                                           // 203
      // Special case: if you specify "added" and "movedBefore", you get an                                           // 204
      // ordered observe where for some reason you don't get ordering data on                                         // 205
      // the adds.  I dunno, we wrote tests for it, there must have been a                                            // 206
      // reason.                                                                                                      // 207
      self._addedBefore = function (id, fields, before) {                                                             // 208
        callbacks.added(id, fields);                                                                                  // 209
      };                                                                                                              // 210
    }                                                                                                                 // 211
  });                                                                                                                 // 212
  self._stopped = false;                                                                                              // 213
  self._id = nextObserveHandleId++;                                                                                   // 214
};                                                                                                                    // 215
ObserveHandle.prototype.stop = function () {                                                                          // 216
  var self = this;                                                                                                    // 217
  if (self._stopped)                                                                                                  // 218
    return;                                                                                                           // 219
  self._stopped = true;                                                                                               // 220
  self._multiplexer.removeHandle(self._id);                                                                           // 221
};                                                                                                                    // 222
                                                                                                                      // 223
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/doc_fetcher.js                                                                                      //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var Fiber = Npm.require('fibers');                                                                                    // 1
var Future = Npm.require('fibers/future');                                                                            // 2
                                                                                                                      // 3
DocFetcher = function (mongoConnection) {                                                                             // 4
  var self = this;                                                                                                    // 5
  self._mongoConnection = mongoConnection;                                                                            // 6
  // Map from cache key -> [callback]                                                                                 // 7
  self._callbacksForCacheKey = {};                                                                                    // 8
};                                                                                                                    // 9
                                                                                                                      // 10
_.extend(DocFetcher.prototype, {                                                                                      // 11
  // Fetches document "id" from collectionName, returning it or null if not                                           // 12
  // found.                                                                                                           // 13
  //                                                                                                                  // 14
  // If you make multiple calls to fetch() with the same cacheKey (a string),                                         // 15
  // DocFetcher may assume that they all return the same document. (It does                                           // 16
  // not check to see if collectionName/id match.)                                                                    // 17
  //                                                                                                                  // 18
  // You may assume that callback is never called synchronously (and in fact                                          // 19
  // OplogObserveDriver does so).                                                                                     // 20
  fetch: function (collectionName, id, cacheKey, callback) {                                                          // 21
    var self = this;                                                                                                  // 22
                                                                                                                      // 23
    check(collectionName, String);                                                                                    // 24
    // id is some sort of scalar                                                                                      // 25
    check(cacheKey, String);                                                                                          // 26
                                                                                                                      // 27
    // If there's already an in-progress fetch for this cache key, yield until                                        // 28
    // it's done and return whatever it returns.                                                                      // 29
    if (_.has(self._callbacksForCacheKey, cacheKey)) {                                                                // 30
      self._callbacksForCacheKey[cacheKey].push(callback);                                                            // 31
      return;                                                                                                         // 32
    }                                                                                                                 // 33
                                                                                                                      // 34
    var callbacks = self._callbacksForCacheKey[cacheKey] = [callback];                                                // 35
                                                                                                                      // 36
    Fiber(function () {                                                                                               // 37
      try {                                                                                                           // 38
        var doc = self._mongoConnection.findOne(                                                                      // 39
          collectionName, {_id: id}) || null;                                                                         // 40
        // Return doc to all relevant callbacks. Note that this array can                                             // 41
        // continue to grow during callback excecution.                                                               // 42
        while (!_.isEmpty(callbacks)) {                                                                               // 43
          // Clone the document so that the various calls to fetch don't return                                       // 44
          // objects that are intertwingled with each other. Clone before                                             // 45
          // popping the future, so that if clone throws, the error gets passed                                       // 46
          // to the next callback.                                                                                    // 47
          var clonedDoc = EJSON.clone(doc);                                                                           // 48
          callbacks.pop()(null, clonedDoc);                                                                           // 49
        }                                                                                                             // 50
      } catch (e) {                                                                                                   // 51
        while (!_.isEmpty(callbacks)) {                                                                               // 52
          callbacks.pop()(e);                                                                                         // 53
        }                                                                                                             // 54
      } finally {                                                                                                     // 55
        // XXX consider keeping the doc around for a period of time before                                            // 56
        // removing from the cache                                                                                    // 57
        delete self._callbacksForCacheKey[cacheKey];                                                                  // 58
      }                                                                                                               // 59
    }).run();                                                                                                         // 60
  }                                                                                                                   // 61
});                                                                                                                   // 62
                                                                                                                      // 63
MongoTest.DocFetcher = DocFetcher;                                                                                    // 64
                                                                                                                      // 65
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/polling_observe_driver.js                                                                           //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
PollingObserveDriver = function (options) {                                                                           // 1
  var self = this;                                                                                                    // 2
                                                                                                                      // 3
  self._cursorDescription = options.cursorDescription;                                                                // 4
  self._mongoHandle = options.mongoHandle;                                                                            // 5
  self._ordered = options.ordered;                                                                                    // 6
  self._multiplexer = options.multiplexer;                                                                            // 7
  self._stopCallbacks = [];                                                                                           // 8
  self._stopped = false;                                                                                              // 9
                                                                                                                      // 10
  self._synchronousCursor = self._mongoHandle._createSynchronousCursor(                                               // 11
    self._cursorDescription);                                                                                         // 12
                                                                                                                      // 13
  // previous results snapshot.  on each poll cycle, diffs against                                                    // 14
  // results drives the callbacks.                                                                                    // 15
  self._results = null;                                                                                               // 16
                                                                                                                      // 17
  // The number of _pollMongo calls that have been added to self._taskQueue but                                       // 18
  // have not started running. Used to make sure we never schedule more than one                                      // 19
  // _pollMongo (other than possibly the one that is currently running). It's                                         // 20
  // also used by _suspendPolling to pretend there's a poll scheduled. Usually,                                       // 21
  // it's either 0 (for "no polls scheduled other than maybe one currently                                            // 22
  // running") or 1 (for "a poll scheduled that isn't running yet"), but it can                                       // 23
  // also be 2 if incremented by _suspendPolling.                                                                     // 24
  self._pollsScheduledButNotStarted = 0;                                                                              // 25
  self._pendingWrites = []; // people to notify when polling completes                                                // 26
                                                                                                                      // 27
  // Make sure to create a separately throttled function for each                                                     // 28
  // PollingObserveDriver object.                                                                                     // 29
  self._ensurePollIsScheduled = _.throttle(                                                                           // 30
    self._unthrottledEnsurePollIsScheduled, 50 /* ms */);                                                             // 31
                                                                                                                      // 32
  // XXX figure out if we still need a queue                                                                          // 33
  self._taskQueue = new Meteor._SynchronousQueue();                                                                   // 34
                                                                                                                      // 35
  var listenersHandle = listenAll(                                                                                    // 36
    self._cursorDescription, function (notification) {                                                                // 37
      // When someone does a transaction that might affect us, schedule a poll                                        // 38
      // of the database. If that transaction happens inside of a write fence,                                        // 39
      // block the fence until we've polled and notified observers.                                                   // 40
      var fence = DDPServer._CurrentWriteFence.get();                                                                 // 41
      if (fence)                                                                                                      // 42
        self._pendingWrites.push(fence.beginWrite());                                                                 // 43
      // Ensure a poll is scheduled... but if we already know that one is,                                            // 44
      // don't hit the throttled _ensurePollIsScheduled function (which might                                         // 45
      // lead to us calling it unnecessarily in 50ms).                                                                // 46
      if (self._pollsScheduledButNotStarted === 0)                                                                    // 47
        self._ensurePollIsScheduled();                                                                                // 48
    }                                                                                                                 // 49
  );                                                                                                                  // 50
  self._stopCallbacks.push(function () { listenersHandle.stop(); });                                                  // 51
                                                                                                                      // 52
  // every once and a while, poll even if we don't think we're dirty, for                                             // 53
  // eventual consistency with database writes from outside the Meteor                                                // 54
  // universe.                                                                                                        // 55
  //                                                                                                                  // 56
  // For testing, there's an undocumented callback argument to observeChanges                                         // 57
  // which disables time-based polling and gets called at the beginning of each                                       // 58
  // poll.                                                                                                            // 59
  if (options._testOnlyPollCallback) {                                                                                // 60
    self._testOnlyPollCallback = options._testOnlyPollCallback;                                                       // 61
  } else {                                                                                                            // 62
    var intervalHandle = Meteor.setInterval(                                                                          // 63
      _.bind(self._ensurePollIsScheduled, self), 10 * 1000);                                                          // 64
    self._stopCallbacks.push(function () {                                                                            // 65
      Meteor.clearInterval(intervalHandle);                                                                           // 66
    });                                                                                                               // 67
  }                                                                                                                   // 68
                                                                                                                      // 69
  // Make sure we actually poll soon!                                                                                 // 70
  self._unthrottledEnsurePollIsScheduled();                                                                           // 71
                                                                                                                      // 72
  Package.facts && Package.facts.Facts.incrementServerFact(                                                           // 73
    "mongo-livedata", "observe-drivers-polling", 1);                                                                  // 74
};                                                                                                                    // 75
                                                                                                                      // 76
_.extend(PollingObserveDriver.prototype, {                                                                            // 77
  // This is always called through _.throttle (except once at startup).                                               // 78
  _unthrottledEnsurePollIsScheduled: function () {                                                                    // 79
    var self = this;                                                                                                  // 80
    if (self._pollsScheduledButNotStarted > 0)                                                                        // 81
      return;                                                                                                         // 82
    ++self._pollsScheduledButNotStarted;                                                                              // 83
    self._taskQueue.queueTask(function () {                                                                           // 84
      self._pollMongo();                                                                                              // 85
    });                                                                                                               // 86
  },                                                                                                                  // 87
                                                                                                                      // 88
  // test-only interface for controlling polling.                                                                     // 89
  //                                                                                                                  // 90
  // _suspendPolling blocks until any currently running and scheduled polls are                                       // 91
  // done, and prevents any further polls from being scheduled. (new                                                  // 92
  // ObserveHandles can be added and receive their initial added callbacks,                                           // 93
  // though.)                                                                                                         // 94
  //                                                                                                                  // 95
  // _resumePolling immediately polls, and allows further polls to occur.                                             // 96
  _suspendPolling: function() {                                                                                       // 97
    var self = this;                                                                                                  // 98
    // Pretend that there's another poll scheduled (which will prevent                                                // 99
    // _ensurePollIsScheduled from queueing any more polls).                                                          // 100
    ++self._pollsScheduledButNotStarted;                                                                              // 101
    // Now block until all currently running or scheduled polls are done.                                             // 102
    self._taskQueue.runTask(function() {});                                                                           // 103
                                                                                                                      // 104
    // Confirm that there is only one "poll" (the fake one we're pretending to                                        // 105
    // have) scheduled.                                                                                               // 106
    if (self._pollsScheduledButNotStarted !== 1)                                                                      // 107
      throw new Error("_pollsScheduledButNotStarted is " +                                                            // 108
                      self._pollsScheduledButNotStarted);                                                             // 109
  },                                                                                                                  // 110
  _resumePolling: function() {                                                                                        // 111
    var self = this;                                                                                                  // 112
    // We should be in the same state as in the end of _suspendPolling.                                               // 113
    if (self._pollsScheduledButNotStarted !== 1)                                                                      // 114
      throw new Error("_pollsScheduledButNotStarted is " +                                                            // 115
                      self._pollsScheduledButNotStarted);                                                             // 116
    // Run a poll synchronously (which will counteract the                                                            // 117
    // ++_pollsScheduledButNotStarted from _suspendPolling).                                                          // 118
    self._taskQueue.runTask(function () {                                                                             // 119
      self._pollMongo();                                                                                              // 120
    });                                                                                                               // 121
  },                                                                                                                  // 122
                                                                                                                      // 123
  _pollMongo: function () {                                                                                           // 124
    var self = this;                                                                                                  // 125
    --self._pollsScheduledButNotStarted;                                                                              // 126
                                                                                                                      // 127
    var first = false;                                                                                                // 128
    var oldResults = self._results;                                                                                   // 129
    if (!oldResults) {                                                                                                // 130
      first = true;                                                                                                   // 131
      // XXX maybe use OrderedDict instead?                                                                           // 132
      oldResults = self._ordered ? [] : new LocalCollection._IdMap;                                                   // 133
    }                                                                                                                 // 134
                                                                                                                      // 135
    self._testOnlyPollCallback && self._testOnlyPollCallback();                                                       // 136
                                                                                                                      // 137
    // Save the list of pending writes which this round will commit.                                                  // 138
    var writesForCycle = self._pendingWrites;                                                                         // 139
    self._pendingWrites = [];                                                                                         // 140
                                                                                                                      // 141
    // Get the new query results. (This yields.)                                                                      // 142
    try {                                                                                                             // 143
      var newResults = self._synchronousCursor.getRawObjects(self._ordered);                                          // 144
    } catch (e) {                                                                                                     // 145
      // getRawObjects can throw if we're having trouble talking to the                                               // 146
      // database.  That's fine --- we will repoll later anyway. But we should                                        // 147
      // make sure not to lose track of this cycle's writes.                                                          // 148
      // (It also can throw if there's just something invalid about this query;                                       // 149
      // unfortunately the ObserveDriver API doesn't provide a good way to                                            // 150
      // "cancel" the observe from the inside in this case.                                                           // 151
      Array.prototype.push.apply(self._pendingWrites, writesForCycle);                                                // 152
      Meteor._debug("Exception while polling query " +                                                                // 153
                    JSON.stringify(self._cursorDescription) + ": " + e.stack);                                        // 154
      return;                                                                                                         // 155
    }                                                                                                                 // 156
                                                                                                                      // 157
    // Run diffs.                                                                                                     // 158
    if (!self._stopped) {                                                                                             // 159
      LocalCollection._diffQueryChanges(                                                                              // 160
        self._ordered, oldResults, newResults, self._multiplexer);                                                    // 161
    }                                                                                                                 // 162
                                                                                                                      // 163
    // Signals the multiplexer to allow all observeChanges calls that share this                                      // 164
    // multiplexer to return. (This happens asynchronously, via the                                                   // 165
    // multiplexer's queue.)                                                                                          // 166
    if (first)                                                                                                        // 167
      self._multiplexer.ready();                                                                                      // 168
                                                                                                                      // 169
    // Replace self._results atomically.  (This assignment is what makes `first`                                      // 170
    // stay through on the next cycle, so we've waited until after we've                                              // 171
    // committed to ready-ing the multiplexer.)                                                                       // 172
    self._results = newResults;                                                                                       // 173
                                                                                                                      // 174
    // Once the ObserveMultiplexer has processed everything we've done in this                                        // 175
    // round, mark all the writes which existed before this call as                                                   // 176
    // commmitted. (If new writes have shown up in the meantime, there'll                                             // 177
    // already be another _pollMongo task scheduled.)                                                                 // 178
    self._multiplexer.onFlush(function () {                                                                           // 179
      _.each(writesForCycle, function (w) {                                                                           // 180
        w.committed();                                                                                                // 181
      });                                                                                                             // 182
    });                                                                                                               // 183
  },                                                                                                                  // 184
                                                                                                                      // 185
  stop: function () {                                                                                                 // 186
    var self = this;                                                                                                  // 187
    self._stopped = true;                                                                                             // 188
    _.each(self._stopCallbacks, function (c) { c(); });                                                               // 189
    // Release any write fences that are waiting on us.                                                               // 190
    _.each(self._pendingWrites, function (w) {                                                                        // 191
      w.committed();                                                                                                  // 192
    });                                                                                                               // 193
    Package.facts && Package.facts.Facts.incrementServerFact(                                                         // 194
      "mongo-livedata", "observe-drivers-polling", -1);                                                               // 195
  }                                                                                                                   // 196
});                                                                                                                   // 197
                                                                                                                      // 198
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/oplog_observe_driver.js                                                                             //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
var Fiber = Npm.require('fibers');                                                                                    // 1
var Future = Npm.require('fibers/future');                                                                            // 2
                                                                                                                      // 3
var PHASE = {                                                                                                         // 4
  QUERYING: "QUERYING",                                                                                               // 5
  FETCHING: "FETCHING",                                                                                               // 6
  STEADY: "STEADY"                                                                                                    // 7
};                                                                                                                    // 8
                                                                                                                      // 9
// Exception thrown by _needToPollQuery which unrolls the stack up to the                                             // 10
// enclosing call to finishIfNeedToPollQuery.                                                                         // 11
var SwitchedToQuery = function () {};                                                                                 // 12
var finishIfNeedToPollQuery = function (f) {                                                                          // 13
  return function () {                                                                                                // 14
    try {                                                                                                             // 15
      f.apply(this, arguments);                                                                                       // 16
    } catch (e) {                                                                                                     // 17
      if (!(e instanceof SwitchedToQuery))                                                                            // 18
        throw e;                                                                                                      // 19
    }                                                                                                                 // 20
  };                                                                                                                  // 21
};                                                                                                                    // 22
                                                                                                                      // 23
// OplogObserveDriver is an alternative to PollingObserveDriver which follows                                         // 24
// the Mongo operation log instead of just re-polling the query. It obeys the                                         // 25
// same simple interface: constructing it starts sending observeChanges                                               // 26
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop                                       // 27
// it by calling the stop() method.                                                                                   // 28
OplogObserveDriver = function (options) {                                                                             // 29
  var self = this;                                                                                                    // 30
  self._usesOplog = true;  // tests look at this                                                                      // 31
                                                                                                                      // 32
  self._cursorDescription = options.cursorDescription;                                                                // 33
  self._mongoHandle = options.mongoHandle;                                                                            // 34
  self._multiplexer = options.multiplexer;                                                                            // 35
                                                                                                                      // 36
  if (options.ordered) {                                                                                              // 37
    throw Error("OplogObserveDriver only supports unordered observeChanges");                                         // 38
  }                                                                                                                   // 39
                                                                                                                      // 40
  var sorter = options.sorter;                                                                                        // 41
  // We don't support $near and other geo-queries so it's OK to initialize the                                        // 42
  // comparator only once in the constructor.                                                                         // 43
  var comparator = sorter && sorter.getComparator();                                                                  // 44
                                                                                                                      // 45
  if (options.cursorDescription.options.limit) {                                                                      // 46
    // There are several properties ordered driver implements:                                                        // 47
    // - _limit is a positive number                                                                                  // 48
    // - _comparator is a function-comparator by which the query is ordered                                           // 49
    // - _unpublishedBuffer is non-null Min/Max Heap,                                                                 // 50
    //                      the empty buffer in STEADY phase implies that the                                         // 51
    //                      everything that matches the queries selector fits                                         // 52
    //                      into published set.                                                                       // 53
    // - _published - Min Heap (also implements IdMap methods)                                                        // 54
                                                                                                                      // 55
    var heapOptions = { IdMap: LocalCollection._IdMap };                                                              // 56
    self._limit = self._cursorDescription.options.limit;                                                              // 57
    self._comparator = comparator;                                                                                    // 58
    self._sorter = sorter;                                                                                            // 59
    self._unpublishedBuffer = new MinMaxHeap(comparator, heapOptions);                                                // 60
    // We need something that can find Max value in addition to IdMap interface                                       // 61
    self._published = new MaxHeap(comparator, heapOptions);                                                           // 62
  } else {                                                                                                            // 63
    self._limit = 0;                                                                                                  // 64
    self._comparator = null;                                                                                          // 65
    self._sorter = null;                                                                                              // 66
    self._unpublishedBuffer = null;                                                                                   // 67
    self._published = new LocalCollection._IdMap;                                                                     // 68
  }                                                                                                                   // 69
                                                                                                                      // 70
  // Indicates if it is safe to insert a new document at the end of the buffer                                        // 71
  // for this query. i.e. it is known that there are no documents matching the                                        // 72
  // selector those are not in published or buffer.                                                                   // 73
  self._safeAppendToBuffer = false;                                                                                   // 74
                                                                                                                      // 75
  self._stopped = false;                                                                                              // 76
  self._stopHandles = [];                                                                                             // 77
                                                                                                                      // 78
  Package.facts && Package.facts.Facts.incrementServerFact(                                                           // 79
    "mongo-livedata", "observe-drivers-oplog", 1);                                                                    // 80
                                                                                                                      // 81
  self._registerPhaseChange(PHASE.QUERYING);                                                                          // 82
                                                                                                                      // 83
  var selector = self._cursorDescription.selector;                                                                    // 84
  self._matcher = options.matcher;                                                                                    // 85
  var projection = self._cursorDescription.options.fields || {};                                                      // 86
  self._projectionFn = LocalCollection._compileProjection(projection);                                                // 87
  // Projection function, result of combining important fields for selector and                                       // 88
  // existing fields projection                                                                                       // 89
  self._sharedProjection = self._matcher.combineIntoProjection(projection);                                           // 90
  if (sorter)                                                                                                         // 91
    self._sharedProjection = sorter.combineIntoProjection(self._sharedProjection);                                    // 92
  self._sharedProjectionFn = LocalCollection._compileProjection(                                                      // 93
    self._sharedProjection);                                                                                          // 94
                                                                                                                      // 95
  self._needToFetch = new LocalCollection._IdMap;                                                                     // 96
  self._currentlyFetching = null;                                                                                     // 97
  self._fetchGeneration = 0;                                                                                          // 98
                                                                                                                      // 99
  self._requeryWhenDoneThisQuery = false;                                                                             // 100
  self._writesToCommitWhenWeReachSteady = [];                                                                         // 101
                                                                                                                      // 102
  forEachTrigger(self._cursorDescription, function (trigger) {                                                        // 103
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(                                               // 104
      trigger, function (notification) {                                                                              // 105
        Meteor._noYieldsAllowed(finishIfNeedToPollQuery(function () {                                                 // 106
          var op = notification.op;                                                                                   // 107
          if (notification.dropCollection) {                                                                          // 108
            // Note: this call is not allowed to block on anything (especially                                        // 109
            // on waiting for oplog entries to catch up) because that will block                                      // 110
            // onOplogEntry!                                                                                          // 111
            self._needToPollQuery();                                                                                  // 112
          } else {                                                                                                    // 113
            // All other operators should be handled depending on phase                                               // 114
            if (self._phase === PHASE.QUERYING)                                                                       // 115
              self._handleOplogEntryQuerying(op);                                                                     // 116
            else                                                                                                      // 117
              self._handleOplogEntrySteadyOrFetching(op);                                                             // 118
          }                                                                                                           // 119
        }));                                                                                                          // 120
      }                                                                                                               // 121
    ));                                                                                                               // 122
  });                                                                                                                 // 123
                                                                                                                      // 124
  // XXX ordering w.r.t. everything else?                                                                             // 125
  self._stopHandles.push(listenAll(                                                                                   // 126
    self._cursorDescription, function (notification) {                                                                // 127
      // If we're not in a write fence, we don't have to do anything.                                                 // 128
      var fence = DDPServer._CurrentWriteFence.get();                                                                 // 129
      if (!fence)                                                                                                     // 130
        return;                                                                                                       // 131
      var write = fence.beginWrite();                                                                                 // 132
      // This write cannot complete until we've caught up to "this point" in the                                      // 133
      // oplog, and then made it back to the steady state.                                                            // 134
      Meteor.defer(function () {                                                                                      // 135
        self._mongoHandle._oplogHandle.waitUntilCaughtUp();                                                           // 136
        if (self._stopped) {                                                                                          // 137
          // We're stopped, so just immediately commit.                                                               // 138
          write.committed();                                                                                          // 139
        } else if (self._phase === PHASE.STEADY) {                                                                    // 140
          // Make sure that all of the callbacks have made it through the                                             // 141
          // multiplexer and been delivered to ObserveHandles before committing                                       // 142
          // writes.                                                                                                  // 143
          self._multiplexer.onFlush(function () {                                                                     // 144
            write.committed();                                                                                        // 145
          });                                                                                                         // 146
        } else {                                                                                                      // 147
          self._writesToCommitWhenWeReachSteady.push(write);                                                          // 148
        }                                                                                                             // 149
      });                                                                                                             // 150
    }                                                                                                                 // 151
  ));                                                                                                                 // 152
                                                                                                                      // 153
  // When Mongo fails over, we need to repoll the query, in case we processed an                                      // 154
  // oplog entry that got rolled back.                                                                                // 155
  self._stopHandles.push(self._mongoHandle._onFailover(finishIfNeedToPollQuery(                                       // 156
    function () {                                                                                                     // 157
      self._needToPollQuery();                                                                                        // 158
    })));                                                                                                             // 159
                                                                                                                      // 160
  // Give _observeChanges a chance to add the new ObserveHandle to our                                                // 161
  // multiplexer, so that the added calls get streamed.                                                               // 162
  Meteor.defer(finishIfNeedToPollQuery(function () {                                                                  // 163
    self._runInitialQuery();                                                                                          // 164
  }));                                                                                                                // 165
};                                                                                                                    // 166
                                                                                                                      // 167
_.extend(OplogObserveDriver.prototype, {                                                                              // 168
  _addPublished: function (id, doc) {                                                                                 // 169
    var self = this;                                                                                                  // 170
    Meteor._noYieldsAllowed(function () {                                                                             // 171
      var fields = _.clone(doc);                                                                                      // 172
      delete fields._id;                                                                                              // 173
      self._published.set(id, self._sharedProjectionFn(doc));                                                         // 174
      self._multiplexer.added(id, self._projectionFn(fields));                                                        // 175
                                                                                                                      // 176
      // After adding this document, the published set might be overflowed                                            // 177
      // (exceeding capacity specified by limit). If so, push the maximum                                             // 178
      // element to the buffer, we might want to save it in memory to reduce the                                      // 179
      // amount of Mongo lookups in the future.                                                                       // 180
      if (self._limit && self._published.size() > self._limit) {                                                      // 181
        // XXX in theory the size of published is no more than limit+1                                                // 182
        if (self._published.size() !== self._limit + 1) {                                                             // 183
          throw new Error("After adding to published, " +                                                             // 184
                          (self._published.size() - self._limit) +                                                    // 185
                          " documents are overflowing the set");                                                      // 186
        }                                                                                                             // 187
                                                                                                                      // 188
        var overflowingDocId = self._published.maxElementId();                                                        // 189
        var overflowingDoc = self._published.get(overflowingDocId);                                                   // 190
                                                                                                                      // 191
        if (EJSON.equals(overflowingDocId, id)) {                                                                     // 192
          throw new Error("The document just added is overflowing the published set");                                // 193
        }                                                                                                             // 194
                                                                                                                      // 195
        self._published.remove(overflowingDocId);                                                                     // 196
        self._multiplexer.removed(overflowingDocId);                                                                  // 197
        self._addBuffered(overflowingDocId, overflowingDoc);                                                          // 198
      }                                                                                                               // 199
    });                                                                                                               // 200
  },                                                                                                                  // 201
  _removePublished: function (id) {                                                                                   // 202
    var self = this;                                                                                                  // 203
    Meteor._noYieldsAllowed(function () {                                                                             // 204
      self._published.remove(id);                                                                                     // 205
      self._multiplexer.removed(id);                                                                                  // 206
      if (! self._limit || self._published.size() === self._limit)                                                    // 207
        return;                                                                                                       // 208
                                                                                                                      // 209
      if (self._published.size() > self._limit)                                                                       // 210
        throw Error("self._published got too big");                                                                   // 211
                                                                                                                      // 212
      // OK, we are publishing less than the limit. Maybe we should look in the                                       // 213
      // buffer to find the next element past what we were publishing before.                                         // 214
                                                                                                                      // 215
      if (!self._unpublishedBuffer.empty()) {                                                                         // 216
        // There's something in the buffer; move the first thing in it to                                             // 217
        // _published.                                                                                                // 218
        var newDocId = self._unpublishedBuffer.minElementId();                                                        // 219
        var newDoc = self._unpublishedBuffer.get(newDocId);                                                           // 220
        self._removeBuffered(newDocId);                                                                               // 221
        self._addPublished(newDocId, newDoc);                                                                         // 222
        return;                                                                                                       // 223
      }                                                                                                               // 224
                                                                                                                      // 225
      // There's nothing in the buffer.  This could mean one of a few things.                                         // 226
                                                                                                                      // 227
      // (a) We could be in the middle of re-running the query (specifically, we                                      // 228
      // could be in _publishNewResults). In that case, _unpublishedBuffer is                                         // 229
      // empty because we clear it at the beginning of _publishNewResults. In                                         // 230
      // this case, our caller already knows the entire answer to the query and                                       // 231
      // we don't need to do anything fancy here.  Just return.                                                       // 232
      if (self._phase === PHASE.QUERYING)                                                                             // 233
        return;                                                                                                       // 234
                                                                                                                      // 235
      // (b) We're pretty confident that the union of _published and                                                  // 236
      // _unpublishedBuffer contain all documents that match selector. Because                                        // 237
      // _unpublishedBuffer is empty, that means we're confident that _published                                      // 238
      // contains all documents that match selector. So we have nothing to do.                                        // 239
      if (self._safeAppendToBuffer)                                                                                   // 240
        return;                                                                                                       // 241
                                                                                                                      // 242
      // (c) Maybe there are other documents out there that should be in our                                          // 243
      // buffer. But in that case, when we emptied _unpublishedBuffer in                                              // 244
      // _removeBuffered, we should have called _needToPollQuery, which will                                          // 245
      // either put something in _unpublishedBuffer or set _safeAppendToBuffer                                        // 246
      // (or both), and it will put us in QUERYING for that whole time. So in                                         // 247
      // fact, we shouldn't be able to get here.                                                                      // 248
                                                                                                                      // 249
      throw new Error("Buffer inexplicably empty");                                                                   // 250
    });                                                                                                               // 251
  },                                                                                                                  // 252
  _changePublished: function (id, oldDoc, newDoc) {                                                                   // 253
    var self = this;                                                                                                  // 254
    Meteor._noYieldsAllowed(function () {                                                                             // 255
      self._published.set(id, self._sharedProjectionFn(newDoc));                                                      // 256
      var changed = LocalCollection._makeChangedFields(_.clone(newDoc), oldDoc);                                      // 257
      changed = self._projectionFn(changed);                                                                          // 258
      if (!_.isEmpty(changed))                                                                                        // 259
        self._multiplexer.changed(id, changed);                                                                       // 260
    });                                                                                                               // 261
  },                                                                                                                  // 262
  _addBuffered: function (id, doc) {                                                                                  // 263
    var self = this;                                                                                                  // 264
    Meteor._noYieldsAllowed(function () {                                                                             // 265
      self._unpublishedBuffer.set(id, self._sharedProjectionFn(doc));                                                 // 266
                                                                                                                      // 267
      // If something is overflowing the buffer, we just remove it from cache                                         // 268
      if (self._unpublishedBuffer.size() > self._limit) {                                                             // 269
        var maxBufferedId = self._unpublishedBuffer.maxElementId();                                                   // 270
                                                                                                                      // 271
        self._unpublishedBuffer.remove(maxBufferedId);                                                                // 272
                                                                                                                      // 273
        // Since something matching is removed from cache (both published set and                                     // 274
        // buffer), set flag to false                                                                                 // 275
        self._safeAppendToBuffer = false;                                                                             // 276
      }                                                                                                               // 277
    });                                                                                                               // 278
  },                                                                                                                  // 279
  // Is called either to remove the doc completely from matching set or to move                                       // 280
  // it to the published set later.                                                                                   // 281
  _removeBuffered: function (id) {                                                                                    // 282
    var self = this;                                                                                                  // 283
    Meteor._noYieldsAllowed(function () {                                                                             // 284
      self._unpublishedBuffer.remove(id);                                                                             // 285
      // To keep the contract "buffer is never empty in STEADY phase unless the                                       // 286
      // everything matching fits into published" true, we poll everything as                                         // 287
      // soon as we see the buffer becoming empty.                                                                    // 288
      if (! self._unpublishedBuffer.size() && ! self._safeAppendToBuffer)                                             // 289
        self._needToPollQuery();                                                                                      // 290
    });                                                                                                               // 291
  },                                                                                                                  // 292
  // Called when a document has joined the "Matching" results set.                                                    // 293
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published                                       // 294
  // and the effect of limit enforced.                                                                                // 295
  _addMatching: function (doc) {                                                                                      // 296
    var self = this;                                                                                                  // 297
    Meteor._noYieldsAllowed(function () {                                                                             // 298
      var id = doc._id;                                                                                               // 299
      if (self._published.has(id))                                                                                    // 300
        throw Error("tried to add something already published " + id);                                                // 301
      if (self._limit && self._unpublishedBuffer.has(id))                                                             // 302
        throw Error("tried to add something already existed in buffer " + id);                                        // 303
                                                                                                                      // 304
      var limit = self._limit;                                                                                        // 305
      var comparator = self._comparator;                                                                              // 306
      var maxPublished = (limit && self._published.size() > 0) ?                                                      // 307
        self._published.get(self._published.maxElementId()) : null;                                                   // 308
      var maxBuffered = (limit && self._unpublishedBuffer.size() > 0)                                                 // 309
        ? self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId())                                         // 310
        : null;                                                                                                       // 311
      // The query is unlimited or didn't publish enough documents yet or the                                         // 312
      // new document would fit into published set pushing the maximum element                                        // 313
      // out, then we need to publish the doc.                                                                        // 314
      var toPublish = ! limit || self._published.size() < limit ||                                                    // 315
        comparator(doc, maxPublished) < 0;                                                                            // 316
                                                                                                                      // 317
      // Otherwise we might need to buffer it (only in case of limited query).                                        // 318
      // Buffering is allowed if the buffer is not filled up yet and all                                              // 319
      // matching docs are either in the published set or in the buffer.                                              // 320
      var canAppendToBuffer = !toPublish && self._safeAppendToBuffer &&                                               // 321
        self._unpublishedBuffer.size() < limit;                                                                       // 322
                                                                                                                      // 323
      // Or if it is small enough to be safely inserted to the middle or the                                          // 324
      // beginning of the buffer.                                                                                     // 325
      var canInsertIntoBuffer = !toPublish && maxBuffered &&                                                          // 326
        comparator(doc, maxBuffered) <= 0;                                                                            // 327
                                                                                                                      // 328
      var toBuffer = canAppendToBuffer || canInsertIntoBuffer;                                                        // 329
                                                                                                                      // 330
      if (toPublish) {                                                                                                // 331
        self._addPublished(id, doc);                                                                                  // 332
      } else if (toBuffer) {                                                                                          // 333
        self._addBuffered(id, doc);                                                                                   // 334
      } else {                                                                                                        // 335
        // dropping it and not saving to the cache                                                                    // 336
        self._safeAppendToBuffer = false;                                                                             // 337
      }                                                                                                               // 338
    });                                                                                                               // 339
  },                                                                                                                  // 340
  // Called when a document leaves the "Matching" results set.                                                        // 341
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published                                       // 342
  // and the effect of limit enforced.                                                                                // 343
  _removeMatching: function (id) {                                                                                    // 344
    var self = this;                                                                                                  // 345
    Meteor._noYieldsAllowed(function () {                                                                             // 346
      if (! self._published.has(id) && ! self._limit)                                                                 // 347
        throw Error("tried to remove something matching but not cached " + id);                                       // 348
                                                                                                                      // 349
      if (self._published.has(id)) {                                                                                  // 350
        self._removePublished(id);                                                                                    // 351
      } else if (self._unpublishedBuffer.has(id)) {                                                                   // 352
        self._removeBuffered(id);                                                                                     // 353
      }                                                                                                               // 354
    });                                                                                                               // 355
  },                                                                                                                  // 356
  _handleDoc: function (id, newDoc) {                                                                                 // 357
    var self = this;                                                                                                  // 358
    Meteor._noYieldsAllowed(function () {                                                                             // 359
      var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;                                        // 360
                                                                                                                      // 361
      var publishedBefore = self._published.has(id);                                                                  // 362
      var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);                                            // 363
      var cachedBefore = publishedBefore || bufferedBefore;                                                           // 364
                                                                                                                      // 365
      if (matchesNow && !cachedBefore) {                                                                              // 366
        self._addMatching(newDoc);                                                                                    // 367
      } else if (cachedBefore && !matchesNow) {                                                                       // 368
        self._removeMatching(id);                                                                                     // 369
      } else if (cachedBefore && matchesNow) {                                                                        // 370
        var oldDoc = self._published.get(id);                                                                         // 371
        var comparator = self._comparator;                                                                            // 372
        var minBuffered = self._limit && self._unpublishedBuffer.size() &&                                            // 373
          self._unpublishedBuffer.get(self._unpublishedBuffer.minElementId());                                        // 374
                                                                                                                      // 375
        if (publishedBefore) {                                                                                        // 376
          // Unlimited case where the document stays in published once it                                             // 377
          // matches or the case when we don't have enough matching docs to                                           // 378
          // publish or the changed but matching doc will stay in published                                           // 379
          // anyways.                                                                                                 // 380
          //                                                                                                          // 381
          // XXX: We rely on the emptiness of buffer. Be sure to maintain the                                         // 382
          // fact that buffer can't be empty if there are matching documents not                                      // 383
          // published. Notably, we don't want to schedule repoll and continue                                        // 384
          // relying on this property.                                                                                // 385
          var staysInPublished = ! self._limit ||                                                                     // 386
            self._unpublishedBuffer.size() === 0 ||                                                                   // 387
            comparator(newDoc, minBuffered) <= 0;                                                                     // 388
                                                                                                                      // 389
          if (staysInPublished) {                                                                                     // 390
            self._changePublished(id, oldDoc, newDoc);                                                                // 391
          } else {                                                                                                    // 392
            // after the change doc doesn't stay in the published, remove it                                          // 393
            self._removePublished(id);                                                                                // 394
            // but it can move into buffered now, check it                                                            // 395
            var maxBuffered = self._unpublishedBuffer.get(                                                            // 396
              self._unpublishedBuffer.maxElementId());                                                                // 397
                                                                                                                      // 398
            var toBuffer = self._safeAppendToBuffer ||                                                                // 399
                  (maxBuffered && comparator(newDoc, maxBuffered) <= 0);                                              // 400
                                                                                                                      // 401
            if (toBuffer) {                                                                                           // 402
              self._addBuffered(id, newDoc);                                                                          // 403
            } else {                                                                                                  // 404
              // Throw away from both published set and buffer                                                        // 405
              self._safeAppendToBuffer = false;                                                                       // 406
            }                                                                                                         // 407
          }                                                                                                           // 408
        } else if (bufferedBefore) {                                                                                  // 409
          oldDoc = self._unpublishedBuffer.get(id);                                                                   // 410
          // remove the old version manually instead of using _removeBuffered so                                      // 411
          // we don't trigger the querying immediately.  if we end this block                                         // 412
          // with the buffer empty, we will need to trigger the query poll                                            // 413
          // manually too.                                                                                            // 414
          self._unpublishedBuffer.remove(id);                                                                         // 415
                                                                                                                      // 416
          var maxPublished = self._published.get(                                                                     // 417
            self._published.maxElementId());                                                                          // 418
          var maxBuffered = self._unpublishedBuffer.size() &&                                                         // 419
                self._unpublishedBuffer.get(                                                                          // 420
                  self._unpublishedBuffer.maxElementId());                                                            // 421
                                                                                                                      // 422
          // the buffered doc was updated, it could move to published                                                 // 423
          var toPublish = comparator(newDoc, maxPublished) < 0;                                                       // 424
                                                                                                                      // 425
          // or stays in buffer even after the change                                                                 // 426
          var staysInBuffer = (! toPublish && self._safeAppendToBuffer) ||                                            // 427
                (!toPublish && maxBuffered &&                                                                         // 428
                 comparator(newDoc, maxBuffered) <= 0);                                                               // 429
                                                                                                                      // 430
          if (toPublish) {                                                                                            // 431
            self._addPublished(id, newDoc);                                                                           // 432
          } else if (staysInBuffer) {                                                                                 // 433
            // stays in buffer but changes                                                                            // 434
            self._unpublishedBuffer.set(id, newDoc);                                                                  // 435
          } else {                                                                                                    // 436
            // Throw away from both published set and buffer                                                          // 437
            self._safeAppendToBuffer = false;                                                                         // 438
            // Normally this check would have been done in _removeBuffered but                                        // 439
            // we didn't use it, so we need to do it ourself now.                                                     // 440
            if (! self._unpublishedBuffer.size()) {                                                                   // 441
              self._needToPollQuery();                                                                                // 442
            }                                                                                                         // 443
          }                                                                                                           // 444
        } else {                                                                                                      // 445
          throw new Error("cachedBefore implies either of publishedBefore or bufferedBefore is true.");               // 446
        }                                                                                                             // 447
      }                                                                                                               // 448
    });                                                                                                               // 449
  },                                                                                                                  // 450
  _fetchModifiedDocuments: function () {                                                                              // 451
    var self = this;                                                                                                  // 452
    Meteor._noYieldsAllowed(function () {                                                                             // 453
      self._registerPhaseChange(PHASE.FETCHING);                                                                      // 454
      // Defer, because nothing called from the oplog entry handler may yield,                                        // 455
      // but fetch() yields.                                                                                          // 456
      Meteor.defer(finishIfNeedToPollQuery(function () {                                                              // 457
        while (!self._stopped && !self._needToFetch.empty()) {                                                        // 458
          if (self._phase === PHASE.QUERYING) {                                                                       // 459
            // While fetching, we decided to go into QUERYING mode, and then we                                       // 460
            // saw another oplog entry, so _needToFetch is not empty. But we                                          // 461
            // shouldn't fetch these documents until AFTER the query is done.                                         // 462
            break;                                                                                                    // 463
          }                                                                                                           // 464
                                                                                                                      // 465
          // Being in steady phase here would be surprising.                                                          // 466
          if (self._phase !== PHASE.FETCHING)                                                                         // 467
            throw new Error("phase in fetchModifiedDocuments: " + self._phase);                                       // 468
                                                                                                                      // 469
          self._currentlyFetching = self._needToFetch;                                                                // 470
          var thisGeneration = ++self._fetchGeneration;                                                               // 471
          self._needToFetch = new LocalCollection._IdMap;                                                             // 472
          var waiting = 0;                                                                                            // 473
          var fut = new Future;                                                                                       // 474
          // This loop is safe, because _currentlyFetching will not be updated                                        // 475
          // during this loop (in fact, it is never mutated).                                                         // 476
          self._currentlyFetching.forEach(function (cacheKey, id) {                                                   // 477
            waiting++;                                                                                                // 478
            self._mongoHandle._docFetcher.fetch(                                                                      // 479
              self._cursorDescription.collectionName, id, cacheKey,                                                   // 480
              finishIfNeedToPollQuery(function (err, doc) {                                                           // 481
                try {                                                                                                 // 482
                  if (err) {                                                                                          // 483
                    Meteor._debug("Got exception while fetching documents: " +                                        // 484
                                  err);                                                                               // 485
                    // If we get an error from the fetcher (eg, trouble                                               // 486
                    // connecting to Mongo), let's just abandon the fetch phase                                       // 487
                    // altogether and fall back to polling. It's not like we're                                       // 488
                    // getting live updates anyway.                                                                   // 489
                    if (self._phase !== PHASE.QUERYING) {                                                             // 490
                      self._needToPollQuery();                                                                        // 491
                    }                                                                                                 // 492
                  } else if (!self._stopped && self._phase === PHASE.FETCHING                                         // 493
                             && self._fetchGeneration === thisGeneration) {                                           // 494
                    // We re-check the generation in case we've had an explicit                                       // 495
                    // _pollQuery call (eg, in another fiber) which should                                            // 496
                    // effectively cancel this round of fetches.  (_pollQuery                                         // 497
                    // increments the generation.)                                                                    // 498
                    self._handleDoc(id, doc);                                                                         // 499
                  }                                                                                                   // 500
                } finally {                                                                                           // 501
                  waiting--;                                                                                          // 502
                  // Because fetch() never calls its callback synchronously,                                          // 503
                  // this is safe (ie, we won't call fut.return() before the                                          // 504
                  // forEach is done).                                                                                // 505
                  if (waiting === 0)                                                                                  // 506
                    fut.return();                                                                                     // 507
                }                                                                                                     // 508
              }));                                                                                                    // 509
          });                                                                                                         // 510
          fut.wait();                                                                                                 // 511
          // Exit now if we've had a _pollQuery call (here or in another fiber).                                      // 512
          if (self._phase === PHASE.QUERYING)                                                                         // 513
            return;                                                                                                   // 514
          self._currentlyFetching = null;                                                                             // 515
        }                                                                                                             // 516
        // We're done fetching, so we can be steady, unless we've had a                                               // 517
        // _pollQuery call (here or in another fiber).                                                                // 518
        if (self._phase !== PHASE.QUERYING)                                                                           // 519
          self._beSteady();                                                                                           // 520
      }));                                                                                                            // 521
    });                                                                                                               // 522
  },                                                                                                                  // 523
  _beSteady: function () {                                                                                            // 524
    var self = this;                                                                                                  // 525
    Meteor._noYieldsAllowed(function () {                                                                             // 526
      self._registerPhaseChange(PHASE.STEADY);                                                                        // 527
      var writes = self._writesToCommitWhenWeReachSteady;                                                             // 528
      self._writesToCommitWhenWeReachSteady = [];                                                                     // 529
      self._multiplexer.onFlush(function () {                                                                         // 530
        _.each(writes, function (w) {                                                                                 // 531
          w.committed();                                                                                              // 532
        });                                                                                                           // 533
      });                                                                                                             // 534
    });                                                                                                               // 535
  },                                                                                                                  // 536
  _handleOplogEntryQuerying: function (op) {                                                                          // 537
    var self = this;                                                                                                  // 538
    Meteor._noYieldsAllowed(function () {                                                                             // 539
      self._needToFetch.set(idForOp(op), op.ts.toString());                                                           // 540
    });                                                                                                               // 541
  },                                                                                                                  // 542
  _handleOplogEntrySteadyOrFetching: function (op) {                                                                  // 543
    var self = this;                                                                                                  // 544
    Meteor._noYieldsAllowed(function () {                                                                             // 545
      var id = idForOp(op);                                                                                           // 546
      // If we're already fetching this one, or about to, we can't optimize;                                          // 547
      // make sure that we fetch it again if necessary.                                                               // 548
      if (self._phase === PHASE.FETCHING &&                                                                           // 549
          ((self._currentlyFetching && self._currentlyFetching.has(id)) ||                                            // 550
           self._needToFetch.has(id))) {                                                                              // 551
        self._needToFetch.set(id, op.ts.toString());                                                                  // 552
        return;                                                                                                       // 553
      }                                                                                                               // 554
                                                                                                                      // 555
      if (op.op === 'd') {                                                                                            // 556
        if (self._published.has(id) ||                                                                                // 557
            (self._limit && self._unpublishedBuffer.has(id)))                                                         // 558
          self._removeMatching(id);                                                                                   // 559
      } else if (op.op === 'i') {                                                                                     // 560
        if (self._published.has(id))                                                                                  // 561
          throw new Error("insert found for already-existing ID in published");                                       // 562
        if (self._unpublishedBuffer && self._unpublishedBuffer.has(id))                                               // 563
          throw new Error("insert found for already-existing ID in buffer");                                          // 564
                                                                                                                      // 565
        // XXX what if selector yields?  for now it can't but later it could                                          // 566
        // have $where                                                                                                // 567
        if (self._matcher.documentMatches(op.o).result)                                                               // 568
          self._addMatching(op.o);                                                                                    // 569
      } else if (op.op === 'u') {                                                                                     // 570
        // Is this a modifier ($set/$unset, which may require us to poll the                                          // 571
        // database to figure out if the whole document matches the selector) or                                      // 572
        // a replacement (in which case we can just directly re-evaluate the                                          // 573
        // selector)?                                                                                                 // 574
        var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset');                                               // 575
        // If this modifier modifies something inside an EJSON custom type (ie,                                       // 576
        // anything with EJSON$), then we can't try to use                                                            // 577
        // LocalCollection._modify, since that just mutates the EJSON encoding,                                       // 578
        // not the actual object.                                                                                     // 579
        var canDirectlyModifyDoc =                                                                                    // 580
          !isReplace && modifierCanBeDirectlyApplied(op.o);                                                           // 581
                                                                                                                      // 582
        var publishedBefore = self._published.has(id);                                                                // 583
        var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);                                          // 584
                                                                                                                      // 585
        if (isReplace) {                                                                                              // 586
          self._handleDoc(id, _.extend({_id: id}, op.o));                                                             // 587
        } else if ((publishedBefore || bufferedBefore) &&                                                             // 588
                   canDirectlyModifyDoc) {                                                                            // 589
          // Oh great, we actually know what the document is, so we can apply                                         // 590
          // this directly.                                                                                           // 591
          var newDoc = self._published.has(id)                                                                        // 592
            ? self._published.get(id) : self._unpublishedBuffer.get(id);                                              // 593
          newDoc = EJSON.clone(newDoc);                                                                               // 594
                                                                                                                      // 595
          newDoc._id = id;                                                                                            // 596
          LocalCollection._modify(newDoc, op.o);                                                                      // 597
          self._handleDoc(id, self._sharedProjectionFn(newDoc));                                                      // 598
        } else if (!canDirectlyModifyDoc ||                                                                           // 599
                   self._matcher.canBecomeTrueByModifier(op.o) ||                                                     // 600
                   (self._sorter && self._sorter.affectedByModifier(op.o))) {                                         // 601
          self._needToFetch.set(id, op.ts.toString());                                                                // 602
          if (self._phase === PHASE.STEADY)                                                                           // 603
            self._fetchModifiedDocuments();                                                                           // 604
        }                                                                                                             // 605
      } else {                                                                                                        // 606
        throw Error("XXX SURPRISING OPERATION: " + op);                                                               // 607
      }                                                                                                               // 608
    });                                                                                                               // 609
  },                                                                                                                  // 610
  // Yields!                                                                                                          // 611
  _runInitialQuery: function () {                                                                                     // 612
    var self = this;                                                                                                  // 613
    if (self._stopped)                                                                                                // 614
      throw new Error("oplog stopped surprisingly early");                                                            // 615
                                                                                                                      // 616
    self._runQuery();  // yields                                                                                      // 617
                                                                                                                      // 618
    if (self._stopped)                                                                                                // 619
      throw new Error("oplog stopped quite early");                                                                   // 620
    // Allow observeChanges calls to return. (After this, it's possible for                                           // 621
    // stop() to be called.)                                                                                          // 622
    self._multiplexer.ready();                                                                                        // 623
                                                                                                                      // 624
    self._doneQuerying();  // yields                                                                                  // 625
  },                                                                                                                  // 626
                                                                                                                      // 627
  // In various circumstances, we may just want to stop processing the oplog and                                      // 628
  // re-run the initial query, just as if we were a PollingObserveDriver.                                             // 629
  //                                                                                                                  // 630
  // This function may not block, because it is called from an oplog entry                                            // 631
  // handler.                                                                                                         // 632
  //                                                                                                                  // 633
  // XXX We should call this when we detect that we've been in FETCHING for "too                                      // 634
  // long".                                                                                                           // 635
  //                                                                                                                  // 636
  // XXX We should call this when we detect Mongo failover (since that might                                          // 637
  // mean that some of the oplog entries we have processed have been rolled                                           // 638
  // back). The Node Mongo driver is in the middle of a bunch of huge                                                 // 639
  // refactorings, including the way that it notifies you when primary                                                // 640
  // changes. Will put off implementing this until driver 1.4 is out.                                                 // 641
  _pollQuery: function () {                                                                                           // 642
    var self = this;                                                                                                  // 643
    Meteor._noYieldsAllowed(function () {                                                                             // 644
      if (self._stopped)                                                                                              // 645
        return;                                                                                                       // 646
                                                                                                                      // 647
      // Yay, we get to forget about all the things we thought we had to fetch.                                       // 648
      self._needToFetch = new LocalCollection._IdMap;                                                                 // 649
      self._currentlyFetching = null;                                                                                 // 650
      ++self._fetchGeneration;  // ignore any in-flight fetches                                                       // 651
      self._registerPhaseChange(PHASE.QUERYING);                                                                      // 652
                                                                                                                      // 653
      // Defer so that we don't yield.  We don't need finishIfNeedToPollQuery                                         // 654
      // here because SwitchedToQuery is not thrown in QUERYING mode.                                                 // 655
      Meteor.defer(function () {                                                                                      // 656
        self._runQuery();                                                                                             // 657
        self._doneQuerying();                                                                                         // 658
      });                                                                                                             // 659
    });                                                                                                               // 660
  },                                                                                                                  // 661
                                                                                                                      // 662
  // Yields!                                                                                                          // 663
  _runQuery: function () {                                                                                            // 664
    var self = this;                                                                                                  // 665
    var newResults, newBuffer;                                                                                        // 666
                                                                                                                      // 667
    // This while loop is just to retry failures.                                                                     // 668
    while (true) {                                                                                                    // 669
      // If we've been stopped, we don't have to run anything any more.                                               // 670
      if (self._stopped)                                                                                              // 671
        return;                                                                                                       // 672
                                                                                                                      // 673
      newResults = new LocalCollection._IdMap;                                                                        // 674
      newBuffer = new LocalCollection._IdMap;                                                                         // 675
                                                                                                                      // 676
      // Query 2x documents as the half excluded from the original query will go                                      // 677
      // into unpublished buffer to reduce additional Mongo lookups in cases                                          // 678
      // when documents are removed from the published set and need a                                                 // 679
      // replacement.                                                                                                 // 680
      // XXX needs more thought on non-zero skip                                                                      // 681
      // XXX 2 is a "magic number" meaning there is an extra chunk of docs for                                        // 682
      // buffer if such is needed.                                                                                    // 683
      var cursor = self._cursorForQuery({ limit: self._limit * 2 });                                                  // 684
      try {                                                                                                           // 685
        cursor.forEach(function (doc, i) {  // yields                                                                 // 686
          if (!self._limit || i < self._limit)                                                                        // 687
            newResults.set(doc._id, doc);                                                                             // 688
          else                                                                                                        // 689
            newBuffer.set(doc._id, doc);                                                                              // 690
        });                                                                                                           // 691
        break;                                                                                                        // 692
      } catch (e) {                                                                                                   // 693
        // During failover (eg) if we get an exception we should log and retry                                        // 694
        // instead of crashing.                                                                                       // 695
        Meteor._debug("Got exception while polling query: " + e);                                                     // 696
        Meteor._sleepForMs(100);                                                                                      // 697
      }                                                                                                               // 698
    }                                                                                                                 // 699
                                                                                                                      // 700
    if (self._stopped)                                                                                                // 701
      return;                                                                                                         // 702
                                                                                                                      // 703
    self._publishNewResults(newResults, newBuffer);                                                                   // 704
  },                                                                                                                  // 705
                                                                                                                      // 706
  // Transitions to QUERYING and runs another query, or (if already in QUERYING)                                      // 707
  // ensures that we will query again later.                                                                          // 708
  //                                                                                                                  // 709
  // This function may not block, because it is called from an oplog entry                                            // 710
  // handler. However, if we were not already in the QUERYING phase, it throws                                        // 711
  // an exception that is caught by the closest surrounding                                                           // 712
  // finishIfNeedToPollQuery call; this ensures that we don't continue running                                        // 713
  // close that was designed for another phase inside PHASE.QUERYING.                                                 // 714
  //                                                                                                                  // 715
  // (It's also necessary whenever logic in this file yields to check that other                                      // 716
  // phases haven't put us into QUERYING mode, though; eg,                                                            // 717
  // _fetchModifiedDocuments does this.)                                                                              // 718
  _needToPollQuery: function () {                                                                                     // 719
    var self = this;                                                                                                  // 720
    Meteor._noYieldsAllowed(function () {                                                                             // 721
      if (self._stopped)                                                                                              // 722
        return;                                                                                                       // 723
                                                                                                                      // 724
      // If we're not already in the middle of a query, we can query now                                              // 725
      // (possibly pausing FETCHING).                                                                                 // 726
      if (self._phase !== PHASE.QUERYING) {                                                                           // 727
        self._pollQuery();                                                                                            // 728
        throw new SwitchedToQuery;                                                                                    // 729
      }                                                                                                               // 730
                                                                                                                      // 731
      // We're currently in QUERYING. Set a flag to ensure that we run another                                        // 732
      // query when we're done.                                                                                       // 733
      self._requeryWhenDoneThisQuery = true;                                                                          // 734
    });                                                                                                               // 735
  },                                                                                                                  // 736
                                                                                                                      // 737
  // Yields!                                                                                                          // 738
  _doneQuerying: function () {                                                                                        // 739
    var self = this;                                                                                                  // 740
                                                                                                                      // 741
    if (self._stopped)                                                                                                // 742
      return;                                                                                                         // 743
    self._mongoHandle._oplogHandle.waitUntilCaughtUp();  // yields                                                    // 744
    if (self._stopped)                                                                                                // 745
      return;                                                                                                         // 746
    if (self._phase !== PHASE.QUERYING)                                                                               // 747
      throw Error("Phase unexpectedly " + self._phase);                                                               // 748
                                                                                                                      // 749
    Meteor._noYieldsAllowed(function () {                                                                             // 750
      if (self._requeryWhenDoneThisQuery) {                                                                           // 751
        self._requeryWhenDoneThisQuery = false;                                                                       // 752
        self._pollQuery();                                                                                            // 753
      } else if (self._needToFetch.empty()) {                                                                         // 754
        self._beSteady();                                                                                             // 755
      } else {                                                                                                        // 756
        self._fetchModifiedDocuments();                                                                               // 757
      }                                                                                                               // 758
    });                                                                                                               // 759
  },                                                                                                                  // 760
                                                                                                                      // 761
  _cursorForQuery: function (optionsOverwrite) {                                                                      // 762
    var self = this;                                                                                                  // 763
    return Meteor._noYieldsAllowed(function () {                                                                      // 764
      // The query we run is almost the same as the cursor we are observing,                                          // 765
      // with a few changes. We need to read all the fields that are relevant to                                      // 766
      // the selector, not just the fields we are going to publish (that's the                                        // 767
      // "shared" projection). And we don't want to apply any transform in the                                        // 768
      // cursor, because observeChanges shouldn't use the transform.                                                  // 769
      var options = _.clone(self._cursorDescription.options);                                                         // 770
                                                                                                                      // 771
      // Allow the caller to modify the options. Useful to specify different                                          // 772
      // skip and limit values.                                                                                       // 773
      _.extend(options, optionsOverwrite);                                                                            // 774
                                                                                                                      // 775
      options.fields = self._sharedProjection;                                                                        // 776
      delete options.transform;                                                                                       // 777
      // We are NOT deep cloning fields or selector here, which should be OK.                                         // 778
      var description = new CursorDescription(                                                                        // 779
        self._cursorDescription.collectionName,                                                                       // 780
        self._cursorDescription.selector,                                                                             // 781
        options);                                                                                                     // 782
      return new Cursor(self._mongoHandle, description);                                                              // 783
    });                                                                                                               // 784
  },                                                                                                                  // 785
                                                                                                                      // 786
                                                                                                                      // 787
  // Replace self._published with newResults (both are IdMaps), invoking observe                                      // 788
  // callbacks on the multiplexer.                                                                                    // 789
  // Replace self._unpublishedBuffer with newBuffer.                                                                  // 790
  //                                                                                                                  // 791
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We                                       // 792
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict                                        // 793
  // (b) Rewrite diff.js to use these classes instead of arrays and objects.                                          // 794
  _publishNewResults: function (newResults, newBuffer) {                                                              // 795
    var self = this;                                                                                                  // 796
    Meteor._noYieldsAllowed(function () {                                                                             // 797
                                                                                                                      // 798
      // If the query is limited and there is a buffer, shut down so it doesn't                                       // 799
      // stay in a way.                                                                                               // 800
      if (self._limit) {                                                                                              // 801
        self._unpublishedBuffer.clear();                                                                              // 802
      }                                                                                                               // 803
                                                                                                                      // 804
      // First remove anything that's gone. Be careful not to modify                                                  // 805
      // self._published while iterating over it.                                                                     // 806
      var idsToRemove = [];                                                                                           // 807
      self._published.forEach(function (doc, id) {                                                                    // 808
        if (!newResults.has(id))                                                                                      // 809
          idsToRemove.push(id);                                                                                       // 810
      });                                                                                                             // 811
      _.each(idsToRemove, function (id) {                                                                             // 812
        self._removePublished(id);                                                                                    // 813
      });                                                                                                             // 814
                                                                                                                      // 815
      // Now do adds and changes.                                                                                     // 816
      // If self has a buffer and limit, the new fetched result will be                                               // 817
      // limited correctly as the query has sort specifier.                                                           // 818
      newResults.forEach(function (doc, id) {                                                                         // 819
        self._handleDoc(id, doc);                                                                                     // 820
      });                                                                                                             // 821
                                                                                                                      // 822
      // Sanity-check that everything we tried to put into _published ended up                                        // 823
      // there.                                                                                                       // 824
      // XXX if this is slow, remove it later                                                                         // 825
      if (self._published.size() !== newResults.size()) {                                                             // 826
        throw Error(                                                                                                  // 827
          "The Mongo server and the Meteor query disagree on how " +                                                  // 828
            "many documents match your query. Maybe it is hitting a Mongo " +                                         // 829
            "edge case? The query is: " +                                                                             // 830
            EJSON.stringify(self._cursorDescription.selector));                                                       // 831
      }                                                                                                               // 832
      self._published.forEach(function (doc, id) {                                                                    // 833
        if (!newResults.has(id))                                                                                      // 834
          throw Error("_published has a doc that newResults doesn't; " + id);                                         // 835
      });                                                                                                             // 836
                                                                                                                      // 837
      // Finally, replace the buffer                                                                                  // 838
      newBuffer.forEach(function (doc, id) {                                                                          // 839
        self._addBuffered(id, doc);                                                                                   // 840
      });                                                                                                             // 841
                                                                                                                      // 842
      self._safeAppendToBuffer = newBuffer.size() < self._limit;                                                      // 843
    });                                                                                                               // 844
  },                                                                                                                  // 845
                                                                                                                      // 846
  // This stop function is invoked from the onStop of the ObserveMultiplexer, so                                      // 847
  // it shouldn't actually be possible to call it until the multiplexer is                                            // 848
  // ready.                                                                                                           // 849
  //                                                                                                                  // 850
  // It's important to check self._stopped after every call in this file that                                         // 851
  // can yield!                                                                                                       // 852
  stop: function () {                                                                                                 // 853
    var self = this;                                                                                                  // 854
    if (self._stopped)                                                                                                // 855
      return;                                                                                                         // 856
    self._stopped = true;                                                                                             // 857
    _.each(self._stopHandles, function (handle) {                                                                     // 858
      handle.stop();                                                                                                  // 859
    });                                                                                                               // 860
                                                                                                                      // 861
    // Note: we *don't* use multiplexer.onFlush here because this stop                                                // 862
    // callback is actually invoked by the multiplexer itself when it has                                             // 863
    // determined that there are no handles left. So nothing is actually going                                        // 864
    // to get flushed (and it's probably not valid to call methods on the                                             // 865
    // dying multiplexer).                                                                                            // 866
    _.each(self._writesToCommitWhenWeReachSteady, function (w) {                                                      // 867
      w.committed();  // maybe yields?                                                                                // 868
    });                                                                                                               // 869
    self._writesToCommitWhenWeReachSteady = null;                                                                     // 870
                                                                                                                      // 871
    // Proactively drop references to potentially big things.                                                         // 872
    self._published = null;                                                                                           // 873
    self._unpublishedBuffer = null;                                                                                   // 874
    self._needToFetch = null;                                                                                         // 875
    self._currentlyFetching = null;                                                                                   // 876
    self._oplogEntryHandle = null;                                                                                    // 877
    self._listenersHandle = null;                                                                                     // 878
                                                                                                                      // 879
    Package.facts && Package.facts.Facts.incrementServerFact(                                                         // 880
      "mongo-livedata", "observe-drivers-oplog", -1);                                                                 // 881
  },                                                                                                                  // 882
                                                                                                                      // 883
  _registerPhaseChange: function (phase) {                                                                            // 884
    var self = this;                                                                                                  // 885
    Meteor._noYieldsAllowed(function () {                                                                             // 886
      var now = new Date;                                                                                             // 887
                                                                                                                      // 888
      if (self._phase) {                                                                                              // 889
        var timeDiff = now - self._phaseStartTime;                                                                    // 890
        Package.facts && Package.facts.Facts.incrementServerFact(                                                     // 891
          "mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);                                     // 892
      }                                                                                                               // 893
                                                                                                                      // 894
      self._phase = phase;                                                                                            // 895
      self._phaseStartTime = now;                                                                                     // 896
    });                                                                                                               // 897
  }                                                                                                                   // 898
});                                                                                                                   // 899
                                                                                                                      // 900
// Does our oplog tailing code support this cursor? For now, we are being very                                        // 901
// conservative and allowing only simple queries with simple options.                                                 // 902
// (This is a "static method".)                                                                                       // 903
OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {                                          // 904
  // First, check the options.                                                                                        // 905
  var options = cursorDescription.options;                                                                            // 906
                                                                                                                      // 907
  // Did the user say no explicitly?                                                                                  // 908
  if (options._disableOplog)                                                                                          // 909
    return false;                                                                                                     // 910
                                                                                                                      // 911
  // skip is not supported: to support it we would need to keep track of all                                          // 912
  // "skipped" documents or at least their ids.                                                                       // 913
  // limit w/o a sort specifier is not supported: current implementation needs a                                      // 914
  // deterministic way to order documents.                                                                            // 915
  if (options.skip || (options.limit && !options.sort)) return false;                                                 // 916
                                                                                                                      // 917
  // If a fields projection option is given check if it is supported by                                               // 918
  // minimongo (some operators are not supported).                                                                    // 919
  if (options.fields) {                                                                                               // 920
    try {                                                                                                             // 921
      LocalCollection._checkSupportedProjection(options.fields);                                                      // 922
    } catch (e) {                                                                                                     // 923
      if (e.name === "MinimongoError")                                                                                // 924
        return false;                                                                                                 // 925
      else                                                                                                            // 926
        throw e;                                                                                                      // 927
    }                                                                                                                 // 928
  }                                                                                                                   // 929
                                                                                                                      // 930
  // We don't allow the following selectors:                                                                          // 931
  //   - $where (not confident that we provide the same JS environment                                                // 932
  //             as Mongo, and can yield!)                                                                            // 933
  //   - $near (has "interesting" properties in MongoDB, like the possibility                                         // 934
  //            of returning an ID multiple times, though even polling maybe                                          // 935
  //            have a bug there)                                                                                     // 936
  //           XXX: once we support it, we would need to think more on how we                                         // 937
  //           initialize the comparators when we create the driver.                                                  // 938
  return !matcher.hasWhere() && !matcher.hasGeoQuery();                                                               // 939
};                                                                                                                    // 940
                                                                                                                      // 941
var modifierCanBeDirectlyApplied = function (modifier) {                                                              // 942
  return _.all(modifier, function (fields, operation) {                                                               // 943
    return _.all(fields, function (value, field) {                                                                    // 944
      return !/EJSON\$/.test(field);                                                                                  // 945
    });                                                                                                               // 946
  });                                                                                                                 // 947
};                                                                                                                    // 948
                                                                                                                      // 949
MongoInternals.OplogObserveDriver = OplogObserveDriver;                                                               // 950
                                                                                                                      // 951
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/local_collection_driver.js                                                                          //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
LocalCollectionDriver = function () {                                                                                 // 1
  var self = this;                                                                                                    // 2
  self.noConnCollections = {};                                                                                        // 3
};                                                                                                                    // 4
                                                                                                                      // 5
var ensureCollection = function (name, collections) {                                                                 // 6
  if (!(name in collections))                                                                                         // 7
    collections[name] = new LocalCollection(name);                                                                    // 8
  return collections[name];                                                                                           // 9
};                                                                                                                    // 10
                                                                                                                      // 11
_.extend(LocalCollectionDriver.prototype, {                                                                           // 12
  open: function (name, conn) {                                                                                       // 13
    var self = this;                                                                                                  // 14
    if (!name)                                                                                                        // 15
      return new LocalCollection;                                                                                     // 16
    if (! conn) {                                                                                                     // 17
      return ensureCollection(name, self.noConnCollections);                                                          // 18
    }                                                                                                                 // 19
    if (! conn._mongo_livedata_collections)                                                                           // 20
      conn._mongo_livedata_collections = {};                                                                          // 21
    // XXX is there a way to keep track of a connection's collections without                                         // 22
    // dangling it off the connection object?                                                                         // 23
    return ensureCollection(name, conn._mongo_livedata_collections);                                                  // 24
  }                                                                                                                   // 25
});                                                                                                                   // 26
                                                                                                                      // 27
// singleton                                                                                                          // 28
LocalCollectionDriver = new LocalCollectionDriver;                                                                    // 29
                                                                                                                      // 30
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/remote_collection_driver.js                                                                         //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
MongoInternals.RemoteCollectionDriver = function (                                                                    // 1
  mongo_url, options) {                                                                                               // 2
  var self = this;                                                                                                    // 3
  self.mongo = new MongoConnection(mongo_url, options);                                                               // 4
};                                                                                                                    // 5
                                                                                                                      // 6
_.extend(MongoInternals.RemoteCollectionDriver.prototype, {                                                           // 7
  open: function (name) {                                                                                             // 8
    var self = this;                                                                                                  // 9
    var ret = {};                                                                                                     // 10
    _.each(                                                                                                           // 11
      ['find', 'findOne', 'insert', 'update', 'upsert',                                                               // 12
       'remove', '_ensureIndex', '_dropIndex', '_createCappedCollection',                                             // 13
       'dropCollection'],                                                                                             // 14
      function (m) {                                                                                                  // 15
        ret[m] = _.bind(self.mongo[m], self.mongo, name);                                                             // 16
      });                                                                                                             // 17
    return ret;                                                                                                       // 18
  }                                                                                                                   // 19
});                                                                                                                   // 20
                                                                                                                      // 21
                                                                                                                      // 22
// Create the singleton RemoteCollectionDriver only on demand, so we                                                  // 23
// only require Mongo configuration if it's actually used (eg, not if                                                 // 24
// you're only trying to receive data from a remote DDP server.)                                                      // 25
MongoInternals.defaultRemoteCollectionDriver = _.once(function () {                                                   // 26
  var connectionOptions = {};                                                                                         // 27
                                                                                                                      // 28
  var mongoUrl = process.env.MONGO_URL;                                                                               // 29
                                                                                                                      // 30
  if (process.env.MONGO_OPLOG_URL) {                                                                                  // 31
    connectionOptions.oplogUrl = process.env.MONGO_OPLOG_URL;                                                         // 32
  }                                                                                                                   // 33
                                                                                                                      // 34
  if (! mongoUrl)                                                                                                     // 35
    throw new Error("MONGO_URL must be set in environment");                                                          // 36
                                                                                                                      // 37
  return new MongoInternals.RemoteCollectionDriver(mongoUrl, connectionOptions);                                      // 38
});                                                                                                                   // 39
                                                                                                                      // 40
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);






(function () {

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                    //
// packages/mongo/collection.js                                                                                       //
//                                                                                                                    //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                      //
// options.connection, if given, is a LivedataClient or LivedataServer                                                // 1
// XXX presently there is no way to destroy/clean up a Collection                                                     // 2
                                                                                                                      // 3
/**                                                                                                                   // 4
 * @summary Namespace for MongoDB-related items                                                                       // 5
 * @namespace                                                                                                         // 6
 */                                                                                                                   // 7
Mongo = {};                                                                                                           // 8
                                                                                                                      // 9
/**                                                                                                                   // 10
 * @summary Constructor for a Collection                                                                              // 11
 * @locus Anywhere                                                                                                    // 12
 * @instancename collection                                                                                           // 13
 * @class                                                                                                             // 14
 * @param {String} name The name of the collection.  If null, creates an unmanaged (unsynchronized) local collection. // 15
 * @param {Object} [options]                                                                                          // 16
 * @param {Object} options.connection The server connection that will manage this collection. Uses the default connection if not specified.  Pass the return value of calling [`DDP.connect`](#ddp_connect) to specify a different server. Pass `null` to specify no connection. Unmanaged (`name` is null) collections cannot specify a connection.
 * @param {String} options.idGeneration The method of generating the `_id` fields of new documents in this collection.  Possible values:
                                                                                                                      // 19
 - **`'STRING'`**: random strings                                                                                     // 20
 - **`'MONGO'`**:  random [`Mongo.ObjectID`](#mongo_object_id) values                                                 // 21
                                                                                                                      // 22
The default id generation technique is `'STRING'`.                                                                    // 23
 * @param {Function} options.transform An optional transformation function. Documents will be passed through this function before being returned from `fetch` or `findOne`, and before being passed to callbacks of `observe`, `map`, `forEach`, `allow`, and `deny`. Transforms are *not* applied for the callbacks of `observeChanges` or to cursors returned from publish functions.
 */                                                                                                                   // 25
Mongo.Collection = function (name, options) {                                                                         // 26
  var self = this;                                                                                                    // 27
  if (! (self instanceof Mongo.Collection))                                                                           // 28
    throw new Error('use "new" to construct a Mongo.Collection');                                                     // 29
                                                                                                                      // 30
  if (!name && (name !== null)) {                                                                                     // 31
    Meteor._debug("Warning: creating anonymous collection. It will not be " +                                         // 32
                  "saved or synchronized over the network. (Pass null for " +                                         // 33
                  "the collection name to turn off this warning.)");                                                  // 34
    name = null;                                                                                                      // 35
  }                                                                                                                   // 36
                                                                                                                      // 37
  if (name !== null && typeof name !== "string") {                                                                    // 38
    throw new Error(                                                                                                  // 39
      "First argument to new Mongo.Collection must be a string or null");                                             // 40
  }                                                                                                                   // 41
                                                                                                                      // 42
  if (options && options.methods) {                                                                                   // 43
    // Backwards compatibility hack with original signature (which passed                                             // 44
    // "connection" directly instead of in options. (Connections must have a "methods"                                // 45
    // method.)                                                                                                       // 46
    // XXX remove before 1.0                                                                                          // 47
    options = {connection: options};                                                                                  // 48
  }                                                                                                                   // 49
  // Backwards compatibility: "connection" used to be called "manager".                                               // 50
  if (options && options.manager && !options.connection) {                                                            // 51
    options.connection = options.manager;                                                                             // 52
  }                                                                                                                   // 53
  options = _.extend({                                                                                                // 54
    connection: undefined,                                                                                            // 55
    idGeneration: 'STRING',                                                                                           // 56
    transform: null,                                                                                                  // 57
    _driver: undefined,                                                                                               // 58
    _preventAutopublish: false                                                                                        // 59
  }, options);                                                                                                        // 60
                                                                                                                      // 61
  switch (options.idGeneration) {                                                                                     // 62
  case 'MONGO':                                                                                                       // 63
    self._makeNewID = function () {                                                                                   // 64
      var src = name ? DDP.randomStream('/collection/' + name) : Random;                                              // 65
      return new Mongo.ObjectID(src.hexString(24));                                                                   // 66
    };                                                                                                                // 67
    break;                                                                                                            // 68
  case 'STRING':                                                                                                      // 69
  default:                                                                                                            // 70
    self._makeNewID = function () {                                                                                   // 71
      var src = name ? DDP.randomStream('/collection/' + name) : Random;                                              // 72
      return src.id();                                                                                                // 73
    };                                                                                                                // 74
    break;                                                                                                            // 75
  }                                                                                                                   // 76
                                                                                                                      // 77
  self._transform = LocalCollection.wrapTransform(options.transform);                                                 // 78
                                                                                                                      // 79
  if (! name || options.connection === null)                                                                          // 80
    // note: nameless collections never have a connection                                                             // 81
    self._connection = null;                                                                                          // 82
  else if (options.connection)                                                                                        // 83
    self._connection = options.connection;                                                                            // 84
  else if (Meteor.isClient)                                                                                           // 85
    self._connection = Meteor.connection;                                                                             // 86
  else                                                                                                                // 87
    self._connection = Meteor.server;                                                                                 // 88
                                                                                                                      // 89
  if (!options._driver) {                                                                                             // 90
    // XXX This check assumes that webapp is loaded so that Meteor.server !==                                         // 91
    // null. We should fully support the case of "want to use a Mongo-backed                                          // 92
    // collection from Node code without webapp", but we don't yet.                                                   // 93
    // #MeteorServerNull                                                                                              // 94
    if (name && self._connection === Meteor.server &&                                                                 // 95
        typeof MongoInternals !== "undefined" &&                                                                      // 96
        MongoInternals.defaultRemoteCollectionDriver) {                                                               // 97
      options._driver = MongoInternals.defaultRemoteCollectionDriver();                                               // 98
    } else {                                                                                                          // 99
      options._driver = LocalCollectionDriver;                                                                        // 100
    }                                                                                                                 // 101
  }                                                                                                                   // 102
                                                                                                                      // 103
  self._collection = options._driver.open(name, self._connection);                                                    // 104
  self._name = name;                                                                                                  // 105
                                                                                                                      // 106
  if (self._connection && self._connection.registerStore) {                                                           // 107
    // OK, we're going to be a slave, replicating some remote                                                         // 108
    // database, except possibly with some temporary divergence while                                                 // 109
    // we have unacknowledged RPC's.                                                                                  // 110
    var ok = self._connection.registerStore(name, {                                                                   // 111
      // Called at the beginning of a batch of updates. batchSize is the number                                       // 112
      // of update calls to expect.                                                                                   // 113
      //                                                                                                              // 114
      // XXX This interface is pretty janky. reset probably ought to go back to                                       // 115
      // being its own function, and callers shouldn't have to calculate                                              // 116
      // batchSize. The optimization of not calling pause/remove should be                                            // 117
      // delayed until later: the first call to update() should buffer its                                            // 118
      // message, and then we can either directly apply it at endUpdate time if                                       // 119
      // it was the only update, or do pauseObservers/apply/apply at the next                                         // 120
      // update() if there's another one.                                                                             // 121
      beginUpdate: function (batchSize, reset) {                                                                      // 122
        // pause observers so users don't see flicker when updating several                                           // 123
        // objects at once (including the post-reconnect reset-and-reapply                                            // 124
        // stage), and so that a re-sorting of a query can take advantage of the                                      // 125
        // full _diffQuery moved calculation instead of applying change one at a                                      // 126
        // time.                                                                                                      // 127
        if (batchSize > 1 || reset)                                                                                   // 128
          self._collection.pauseObservers();                                                                          // 129
                                                                                                                      // 130
        if (reset)                                                                                                    // 131
          self._collection.remove({});                                                                                // 132
      },                                                                                                              // 133
                                                                                                                      // 134
      // Apply an update.                                                                                             // 135
      // XXX better specify this interface (not in terms of a wire message)?                                          // 136
      update: function (msg) {                                                                                        // 137
        var mongoId = LocalCollection._idParse(msg.id);                                                               // 138
        var doc = self._collection.findOne(mongoId);                                                                  // 139
                                                                                                                      // 140
        // Is this a "replace the whole doc" message coming from the quiescence                                       // 141
        // of method writes to an object? (Note that 'undefined' is a valid                                           // 142
        // value meaning "remove it".)                                                                                // 143
        if (msg.msg === 'replace') {                                                                                  // 144
          var replace = msg.replace;                                                                                  // 145
          if (!replace) {                                                                                             // 146
            if (doc)                                                                                                  // 147
              self._collection.remove(mongoId);                                                                       // 148
          } else if (!doc) {                                                                                          // 149
            self._collection.insert(replace);                                                                         // 150
          } else {                                                                                                    // 151
            // XXX check that replace has no $ ops                                                                    // 152
            self._collection.update(mongoId, replace);                                                                // 153
          }                                                                                                           // 154
          return;                                                                                                     // 155
        } else if (msg.msg === 'added') {                                                                             // 156
          if (doc) {                                                                                                  // 157
            throw new Error("Expected not to find a document already present for an add");                            // 158
          }                                                                                                           // 159
          self._collection.insert(_.extend({_id: mongoId}, msg.fields));                                              // 160
        } else if (msg.msg === 'removed') {                                                                           // 161
          if (!doc)                                                                                                   // 162
            throw new Error("Expected to find a document already present for removed");                               // 163
          self._collection.remove(mongoId);                                                                           // 164
        } else if (msg.msg === 'changed') {                                                                           // 165
          if (!doc)                                                                                                   // 166
            throw new Error("Expected to find a document to change");                                                 // 167
          if (!_.isEmpty(msg.fields)) {                                                                               // 168
            var modifier = {};                                                                                        // 169
            _.each(msg.fields, function (value, key) {                                                                // 170
              if (value === undefined) {                                                                              // 171
                if (!modifier.$unset)                                                                                 // 172
                  modifier.$unset = {};                                                                               // 173
                modifier.$unset[key] = 1;                                                                             // 174
              } else {                                                                                                // 175
                if (!modifier.$set)                                                                                   // 176
                  modifier.$set = {};                                                                                 // 177
                modifier.$set[key] = value;                                                                           // 178
              }                                                                                                       // 179
            });                                                                                                       // 180
            self._collection.update(mongoId, modifier);                                                               // 181
          }                                                                                                           // 182
        } else {                                                                                                      // 183
          throw new Error("I don't know how to deal with this message");                                              // 184
        }                                                                                                             // 185
                                                                                                                      // 186
      },                                                                                                              // 187
                                                                                                                      // 188
      // Called at the end of a batch of updates.                                                                     // 189
      endUpdate: function () {                                                                                        // 190
        self._collection.resumeObservers();                                                                           // 191
      },                                                                                                              // 192
                                                                                                                      // 193
      // Called around method stub invocations to capture the original versions                                       // 194
      // of modified documents.                                                                                       // 195
      saveOriginals: function () {                                                                                    // 196
        self._collection.saveOriginals();                                                                             // 197
      },                                                                                                              // 198
      retrieveOriginals: function () {                                                                                // 199
        return self._collection.retrieveOriginals();                                                                  // 200
      }                                                                                                               // 201
    });                                                                                                               // 202
                                                                                                                      // 203
    if (!ok)                                                                                                          // 204
      throw new Error("There is already a collection named '" + name + "'");                                          // 205
  }                                                                                                                   // 206
                                                                                                                      // 207
  self._defineMutationMethods();                                                                                      // 208
                                                                                                                      // 209
  // autopublish                                                                                                      // 210
  if (Package.autopublish && !options._preventAutopublish && self._connection                                         // 211
      && self._connection.publish) {                                                                                  // 212
    self._connection.publish(null, function () {                                                                      // 213
      return self.find();                                                                                             // 214
    }, {is_auto: true});                                                                                              // 215
  }                                                                                                                   // 216
};                                                                                                                    // 217
                                                                                                                      // 218
///                                                                                                                   // 219
/// Main collection API                                                                                               // 220
///                                                                                                                   // 221
                                                                                                                      // 222
                                                                                                                      // 223
_.extend(Mongo.Collection.prototype, {                                                                                // 224
                                                                                                                      // 225
  _getFindSelector: function (args) {                                                                                 // 226
    if (args.length == 0)                                                                                             // 227
      return {};                                                                                                      // 228
    else                                                                                                              // 229
      return args[0];                                                                                                 // 230
  },                                                                                                                  // 231
                                                                                                                      // 232
  _getFindOptions: function (args) {                                                                                  // 233
    var self = this;                                                                                                  // 234
    if (args.length < 2) {                                                                                            // 235
      return { transform: self._transform };                                                                          // 236
    } else {                                                                                                          // 237
      check(args[1], Match.Optional(Match.ObjectIncluding({                                                           // 238
        fields: Match.Optional(Match.OneOf(Object, undefined)),                                                       // 239
        sort: Match.Optional(Match.OneOf(Object, Array, undefined)),                                                  // 240
        limit: Match.Optional(Match.OneOf(Number, undefined)),                                                        // 241
        skip: Match.Optional(Match.OneOf(Number, undefined))                                                          // 242
     })));                                                                                                            // 243
                                                                                                                      // 244
      return _.extend({                                                                                               // 245
        transform: self._transform                                                                                    // 246
      }, args[1]);                                                                                                    // 247
    }                                                                                                                 // 248
  },                                                                                                                  // 249
                                                                                                                      // 250
  /**                                                                                                                 // 251
   * @summary Find the documents in a collection that match the selector.                                             // 252
   * @locus Anywhere                                                                                                  // 253
   * @method find                                                                                                     // 254
   * @memberOf Mongo.Collection                                                                                       // 255
   * @instance                                                                                                        // 256
   * @param {MongoSelector} [selector] A query describing the documents to find                                       // 257
   * @param {Object} [options]                                                                                        // 258
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)                                     // 259
   * @param {Number} options.skip Number of results to skip at the beginning                                          // 260
   * @param {Number} options.limit Maximum number of results to return                                                // 261
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.                           // 262
   * @param {Boolean} options.reactive (Client only) Default `true`; pass `false` to disable reactivity               // 263
   * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @returns {Mongo.Cursor}                                                                                          // 265
   */                                                                                                                 // 266
  find: function (/* selector, options */) {                                                                          // 267
    // Collection.find() (return all docs) behaves differently                                                        // 268
    // from Collection.find(undefined) (return 0 docs).  so be                                                        // 269
    // careful about the length of arguments.                                                                         // 270
    var self = this;                                                                                                  // 271
    var argArray = _.toArray(arguments);                                                                              // 272
    return self._collection.find(self._getFindSelector(argArray),                                                     // 273
                                 self._getFindOptions(argArray));                                                     // 274
  },                                                                                                                  // 275
                                                                                                                      // 276
  /**                                                                                                                 // 277
   * @summary Finds the first document that matches the selector, as ordered by sort and skip options.                // 278
   * @locus Anywhere                                                                                                  // 279
   * @method findOne                                                                                                  // 280
   * @memberOf Mongo.Collection                                                                                       // 281
   * @instance                                                                                                        // 282
   * @param {MongoSelector} [selector] A query describing the documents to find                                       // 283
   * @param {Object} [options]                                                                                        // 284
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)                                     // 285
   * @param {Number} options.skip Number of results to skip at the beginning                                          // 286
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.                           // 287
   * @param {Boolean} options.reactive (Client only) Default true; pass false to disable reactivity                   // 288
   * @param {Function} options.transform Overrides `transform` on the [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @returns {Object}                                                                                                // 290
   */                                                                                                                 // 291
  findOne: function (/* selector, options */) {                                                                       // 292
    var self = this;                                                                                                  // 293
    var argArray = _.toArray(arguments);                                                                              // 294
    return self._collection.findOne(self._getFindSelector(argArray),                                                  // 295
                                    self._getFindOptions(argArray));                                                  // 296
  }                                                                                                                   // 297
                                                                                                                      // 298
});                                                                                                                   // 299
                                                                                                                      // 300
Mongo.Collection._publishCursor = function (cursor, sub, collection) {                                                // 301
  var observeHandle = cursor.observeChanges({                                                                         // 302
    added: function (id, fields) {                                                                                    // 303
      sub.added(collection, id, fields);                                                                              // 304
    },                                                                                                                // 305
    changed: function (id, fields) {                                                                                  // 306
      sub.changed(collection, id, fields);                                                                            // 307
    },                                                                                                                // 308
    removed: function (id) {                                                                                          // 309
      sub.removed(collection, id);                                                                                    // 310
    }                                                                                                                 // 311
  });                                                                                                                 // 312
                                                                                                                      // 313
  // We don't call sub.ready() here: it gets called in livedata_server, after                                         // 314
  // possibly calling _publishCursor on multiple returned cursors.                                                    // 315
                                                                                                                      // 316
  // register stop callback (expects lambda w/ no args).                                                              // 317
  sub.onStop(function () {observeHandle.stop();});                                                                    // 318
};                                                                                                                    // 319
                                                                                                                      // 320
// protect against dangerous selectors.  falsey and {_id: falsey} are both                                            // 321
// likely programmer error, and not what you want, particularly for destructive                                       // 322
// operations.  JS regexps don't serialize over DDP but can be trivially                                              // 323
// replaced by $regex.                                                                                                // 324
Mongo.Collection._rewriteSelector = function (selector) {                                                             // 325
  // shorthand -- scalars match _id                                                                                   // 326
  if (LocalCollection._selectorIsId(selector))                                                                        // 327
    selector = {_id: selector};                                                                                       // 328
                                                                                                                      // 329
  if (!selector || (('_id' in selector) && !selector._id))                                                            // 330
    // can't match anything                                                                                           // 331
    return {_id: Random.id()};                                                                                        // 332
                                                                                                                      // 333
  var ret = {};                                                                                                       // 334
  _.each(selector, function (value, key) {                                                                            // 335
    // Mongo supports both {field: /foo/} and {field: {$regex: /foo/}}                                                // 336
    if (value instanceof RegExp) {                                                                                    // 337
      ret[key] = convertRegexpToMongoSelector(value);                                                                 // 338
    } else if (value && value.$regex instanceof RegExp) {                                                             // 339
      ret[key] = convertRegexpToMongoSelector(value.$regex);                                                          // 340
      // if value is {$regex: /foo/, $options: ...} then $options                                                     // 341
      // override the ones set on $regex.                                                                             // 342
      if (value.$options !== undefined)                                                                               // 343
        ret[key].$options = value.$options;                                                                           // 344
    }                                                                                                                 // 345
    else if (_.contains(['$or','$and','$nor'], key)) {                                                                // 346
      // Translate lower levels of $and/$or/$nor                                                                      // 347
      ret[key] = _.map(value, function (v) {                                                                          // 348
        return Mongo.Collection._rewriteSelector(v);                                                                  // 349
      });                                                                                                             // 350
    } else {                                                                                                          // 351
      ret[key] = value;                                                                                               // 352
    }                                                                                                                 // 353
  });                                                                                                                 // 354
  return ret;                                                                                                         // 355
};                                                                                                                    // 356
                                                                                                                      // 357
// convert a JS RegExp object to a Mongo {$regex: ..., $options: ...}                                                 // 358
// selector                                                                                                           // 359
var convertRegexpToMongoSelector = function (regexp) {                                                                // 360
  check(regexp, RegExp); // safety belt                                                                               // 361
                                                                                                                      // 362
  var selector = {$regex: regexp.source};                                                                             // 363
  var regexOptions = '';                                                                                              // 364
  // JS RegExp objects support 'i', 'm', and 'g'. Mongo regex $options                                                // 365
  // support 'i', 'm', 'x', and 's'. So we support 'i' and 'm' here.                                                  // 366
  if (regexp.ignoreCase)                                                                                              // 367
    regexOptions += 'i';                                                                                              // 368
  if (regexp.multiline)                                                                                               // 369
    regexOptions += 'm';                                                                                              // 370
  if (regexOptions)                                                                                                   // 371
    selector.$options = regexOptions;                                                                                 // 372
                                                                                                                      // 373
  return selector;                                                                                                    // 374
};                                                                                                                    // 375
                                                                                                                      // 376
var throwIfSelectorIsNotId = function (selector, methodName) {                                                        // 377
  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector)) {                                                      // 378
    throw new Meteor.Error(                                                                                           // 379
      403, "Not permitted. Untrusted code may only " + methodName +                                                   // 380
        " documents by ID.");                                                                                         // 381
  }                                                                                                                   // 382
};                                                                                                                    // 383
                                                                                                                      // 384
// 'insert' immediately returns the inserted document's new _id.                                                      // 385
// The others return values immediately if you are in a stub, an in-memory                                            // 386
// unmanaged collection, or a mongo-backed collection and you don't pass a                                            // 387
// callback. 'update' and 'remove' return the number of affected                                                      // 388
// documents. 'upsert' returns an object with keys 'numberAffected' and, if an                                        // 389
// insert happened, 'insertedId'.                                                                                     // 390
//                                                                                                                    // 391
// Otherwise, the semantics are exactly like other methods: they take                                                 // 392
// a callback as an optional last argument; if no callback is                                                         // 393
// provided, they block until the operation is complete, and throw an                                                 // 394
// exception if it fails; if a callback is provided, then they don't                                                  // 395
// necessarily block, and they call the callback when they finish with error and                                      // 396
// result arguments.  (The insert method provides the document ID as its result;                                      // 397
// update and remove provide the number of affected docs as the result; upsert                                        // 398
// provides an object with numberAffected and maybe insertedId.)                                                      // 399
//                                                                                                                    // 400
// On the client, blocking is impossible, so if a callback                                                            // 401
// isn't provided, they just return immediately and any error                                                         // 402
// information is lost.                                                                                               // 403
//                                                                                                                    // 404
// There's one more tweak. On the client, if you don't provide a                                                      // 405
// callback, then if there is an error, a message will be logged with                                                 // 406
// Meteor._debug.                                                                                                     // 407
//                                                                                                                    // 408
// The intent (though this is actually determined by the underlying                                                   // 409
// drivers) is that the operations should be done synchronously, not                                                  // 410
// generating their result until the database has acknowledged                                                        // 411
// them. In the future maybe we should provide a flag to turn this                                                    // 412
// off.                                                                                                               // 413
                                                                                                                      // 414
/**                                                                                                                   // 415
 * @summary Insert a document in the collection.  Returns its unique _id.                                             // 416
 * @locus Anywhere                                                                                                    // 417
 * @method  insert                                                                                                    // 418
 * @memberOf Mongo.Collection                                                                                         // 419
 * @instance                                                                                                          // 420
 * @param {Object} doc The document to insert. May not yet have an _id attribute, in which case Meteor will generate one for you.
 * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the _id as the second.
 */                                                                                                                   // 423
                                                                                                                      // 424
/**                                                                                                                   // 425
 * @summary Modify one or more documents in the collection. Returns the number of affected documents.                 // 426
 * @locus Anywhere                                                                                                    // 427
 * @method update                                                                                                     // 428
 * @memberOf Mongo.Collection                                                                                         // 429
 * @instance                                                                                                          // 430
 * @param {MongoSelector} selector Specifies which documents to modify                                                // 431
 * @param {MongoModifier} modifier Specifies how to modify the documents                                              // 432
 * @param {Object} [options]                                                                                          // 433
 * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
 * @param {Boolean} options.upsert True to insert a document if no matching documents are found.                      // 435
 * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
 */                                                                                                                   // 437
                                                                                                                      // 438
/**                                                                                                                   // 439
 * @summary Remove documents from the collection                                                                      // 440
 * @locus Anywhere                                                                                                    // 441
 * @method remove                                                                                                     // 442
 * @memberOf Mongo.Collection                                                                                         // 443
 * @instance                                                                                                          // 444
 * @param {MongoSelector} selector Specifies which documents to remove                                                // 445
 * @param {Function} [callback] Optional.  If present, called with an error object as its argument.                   // 446
 */                                                                                                                   // 447
                                                                                                                      // 448
_.each(["insert", "update", "remove"], function (name) {                                                              // 449
  Mongo.Collection.prototype[name] = function (/* arguments */) {                                                     // 450
    var self = this;                                                                                                  // 451
    var args = _.toArray(arguments);                                                                                  // 452
    var callback;                                                                                                     // 453
    var insertId;                                                                                                     // 454
    var ret;                                                                                                          // 455
                                                                                                                      // 456
    // Pull off any callback (or perhaps a 'callback' variable that was passed                                        // 457
    // in undefined, like how 'upsert' does it).                                                                      // 458
    if (args.length &&                                                                                                // 459
        (args[args.length - 1] === undefined ||                                                                       // 460
         args[args.length - 1] instanceof Function)) {                                                                // 461
      callback = args.pop();                                                                                          // 462
    }                                                                                                                 // 463
                                                                                                                      // 464
    if (name === "insert") {                                                                                          // 465
      if (!args.length)                                                                                               // 466
        throw new Error("insert requires an argument");                                                               // 467
      // shallow-copy the document and generate an ID                                                                 // 468
      args[0] = _.extend({}, args[0]);                                                                                // 469
      if ('_id' in args[0]) {                                                                                         // 470
        insertId = args[0]._id;                                                                                       // 471
        if (!insertId || !(typeof insertId === 'string'                                                               // 472
              || insertId instanceof Mongo.ObjectID))                                                                 // 473
          throw new Error("Meteor requires document _id fields to be non-empty strings or ObjectIDs");                // 474
      } else {                                                                                                        // 475
        var generateId = true;                                                                                        // 476
        // Don't generate the id if we're the client and the 'outermost' call                                         // 477
        // This optimization saves us passing both the randomSeed and the id                                          // 478
        // Passing both is redundant.                                                                                 // 479
        if (self._connection && self._connection !== Meteor.server) {                                                 // 480
          var enclosing = DDP._CurrentInvocation.get();                                                               // 481
          if (!enclosing) {                                                                                           // 482
            generateId = false;                                                                                       // 483
          }                                                                                                           // 484
        }                                                                                                             // 485
        if (generateId) {                                                                                             // 486
          insertId = args[0]._id = self._makeNewID();                                                                 // 487
        }                                                                                                             // 488
      }                                                                                                               // 489
    } else {                                                                                                          // 490
      args[0] = Mongo.Collection._rewriteSelector(args[0]);                                                           // 491
                                                                                                                      // 492
      if (name === "update") {                                                                                        // 493
        // Mutate args but copy the original options object. We need to add                                           // 494
        // insertedId to options, but don't want to mutate the caller's options                                       // 495
        // object. We need to mutate `args` because we pass `args` into the                                           // 496
        // driver below.                                                                                              // 497
        var options = args[2] = _.clone(args[2]) || {};                                                               // 498
        if (options && typeof options !== "function" && options.upsert) {                                             // 499
          // set `insertedId` if absent.  `insertedId` is a Meteor extension.                                         // 500
          if (options.insertedId) {                                                                                   // 501
            if (!(typeof options.insertedId === 'string'                                                              // 502
                  || options.insertedId instanceof Mongo.ObjectID))                                                   // 503
              throw new Error("insertedId must be string or ObjectID");                                               // 504
          } else if (! args[0]._id) {                                                                                 // 505
            options.insertedId = self._makeNewID();                                                                   // 506
          }                                                                                                           // 507
        }                                                                                                             // 508
      }                                                                                                               // 509
    }                                                                                                                 // 510
                                                                                                                      // 511
    // On inserts, always return the id that we generated; on all other                                               // 512
    // operations, just return the result from the collection.                                                        // 513
    var chooseReturnValueFromCollectionResult = function (result) {                                                   // 514
      if (name === "insert") {                                                                                        // 515
        if (!insertId && result) {                                                                                    // 516
          insertId = result;                                                                                          // 517
        }                                                                                                             // 518
        return insertId;                                                                                              // 519
      } else {                                                                                                        // 520
        return result;                                                                                                // 521
      }                                                                                                               // 522
    };                                                                                                                // 523
                                                                                                                      // 524
    var wrappedCallback;                                                                                              // 525
    if (callback) {                                                                                                   // 526
      wrappedCallback = function (error, result) {                                                                    // 527
        callback(error, ! error && chooseReturnValueFromCollectionResult(result));                                    // 528
      };                                                                                                              // 529
    }                                                                                                                 // 530
                                                                                                                      // 531
    // XXX see #MeteorServerNull                                                                                      // 532
    if (self._connection && self._connection !== Meteor.server) {                                                     // 533
      // just remote to another endpoint, propagate return value or                                                   // 534
      // exception.                                                                                                   // 535
                                                                                                                      // 536
      var enclosing = DDP._CurrentInvocation.get();                                                                   // 537
      var alreadyInSimulation = enclosing && enclosing.isSimulation;                                                  // 538
                                                                                                                      // 539
      if (Meteor.isClient && !wrappedCallback && ! alreadyInSimulation) {                                             // 540
        // Client can't block, so it can't report errors by exception,                                                // 541
        // only by callback. If they forget the callback, give them a                                                 // 542
        // default one that logs the error, so they aren't totally                                                    // 543
        // baffled if their writes don't work because their database is                                               // 544
        // down.                                                                                                      // 545
        // Don't give a default callback in simulation, because inside stubs we                                       // 546
        // want to return the results from the local collection immediately and                                       // 547
        // not force a callback.                                                                                      // 548
        wrappedCallback = function (err) {                                                                            // 549
          if (err)                                                                                                    // 550
            Meteor._debug(name + " failed: " + (err.reason || err.stack));                                            // 551
        };                                                                                                            // 552
      }                                                                                                               // 553
                                                                                                                      // 554
      if (!alreadyInSimulation && name !== "insert") {                                                                // 555
        // If we're about to actually send an RPC, we should throw an error if                                        // 556
        // this is a non-ID selector, because the mutation methods only allow                                         // 557
        // single-ID selectors. (If we don't throw here, we'll see flicker.)                                          // 558
        throwIfSelectorIsNotId(args[0], name);                                                                        // 559
      }                                                                                                               // 560
                                                                                                                      // 561
      ret = chooseReturnValueFromCollectionResult(                                                                    // 562
        self._connection.apply(self._prefix + name, args, {returnStubValue: true}, wrappedCallback)                   // 563
      );                                                                                                              // 564
                                                                                                                      // 565
    } else {                                                                                                          // 566
      // it's my collection.  descend into the collection object                                                      // 567
      // and propagate any exception.                                                                                 // 568
      args.push(wrappedCallback);                                                                                     // 569
      try {                                                                                                           // 570
        // If the user provided a callback and the collection implements this                                         // 571
        // operation asynchronously, then queryRet will be undefined, and the                                         // 572
        // result will be returned through the callback instead.                                                      // 573
        var queryRet = self._collection[name].apply(self._collection, args);                                          // 574
        ret = chooseReturnValueFromCollectionResult(queryRet);                                                        // 575
      } catch (e) {                                                                                                   // 576
        if (callback) {                                                                                               // 577
          callback(e);                                                                                                // 578
          return null;                                                                                                // 579
        }                                                                                                             // 580
        throw e;                                                                                                      // 581
      }                                                                                                               // 582
    }                                                                                                                 // 583
                                                                                                                      // 584
    // both sync and async, unless we threw an exception, return ret                                                  // 585
    // (new document ID for insert, num affected for update/remove, object with                                       // 586
    // numberAffected and maybe insertedId for upsert).                                                               // 587
    return ret;                                                                                                       // 588
  };                                                                                                                  // 589
});                                                                                                                   // 590
                                                                                                                      // 591
/**                                                                                                                   // 592
 * @summary Modify one or more documents in the collection, or insert one if no matching documents were found. Returns an object with keys `numberAffected` (the number of documents modified)  and `insertedId` (the unique _id of the document that was inserted, if any).
 * @locus Anywhere                                                                                                    // 594
 * @param {MongoSelector} selector Specifies which documents to modify                                                // 595
 * @param {MongoModifier} modifier Specifies how to modify the documents                                              // 596
 * @param {Object} [options]                                                                                          // 597
 * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
 * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
 */                                                                                                                   // 600
Mongo.Collection.prototype.upsert = function (selector, modifier,                                                     // 601
                                               options, callback) {                                                   // 602
  var self = this;                                                                                                    // 603
  if (! callback && typeof options === "function") {                                                                  // 604
    callback = options;                                                                                               // 605
    options = {};                                                                                                     // 606
  }                                                                                                                   // 607
  return self.update(selector, modifier,                                                                              // 608
              _.extend({}, options, { _returnObject: true, upsert: true }),                                           // 609
              callback);                                                                                              // 610
};                                                                                                                    // 611
                                                                                                                      // 612
// We'll actually design an index API later. For now, we just pass through to                                         // 613
// Mongo's, but make it synchronous.                                                                                  // 614
Mongo.Collection.prototype._ensureIndex = function (index, options) {                                                 // 615
  var self = this;                                                                                                    // 616
  if (!self._collection._ensureIndex)                                                                                 // 617
    throw new Error("Can only call _ensureIndex on server collections");                                              // 618
  self._collection._ensureIndex(index, options);                                                                      // 619
};                                                                                                                    // 620
Mongo.Collection.prototype._dropIndex = function (index) {                                                            // 621
  var self = this;                                                                                                    // 622
  if (!self._collection._dropIndex)                                                                                   // 623
    throw new Error("Can only call _dropIndex on server collections");                                                // 624
  self._collection._dropIndex(index);                                                                                 // 625
};                                                                                                                    // 626
Mongo.Collection.prototype._dropCollection = function () {                                                            // 627
  var self = this;                                                                                                    // 628
  if (!self._collection.dropCollection)                                                                               // 629
    throw new Error("Can only call _dropCollection on server collections");                                           // 630
  self._collection.dropCollection();                                                                                  // 631
};                                                                                                                    // 632
Mongo.Collection.prototype._createCappedCollection = function (byteSize, maxDocuments) {                              // 633
  var self = this;                                                                                                    // 634
  if (!self._collection._createCappedCollection)                                                                      // 635
    throw new Error("Can only call _createCappedCollection on server collections");                                   // 636
  self._collection._createCappedCollection(byteSize, maxDocuments);                                                   // 637
};                                                                                                                    // 638
                                                                                                                      // 639
/**                                                                                                                   // 640
 * @summary Create a Mongo-style `ObjectID`.  If you don't specify a `hexString`, the `ObjectID` will generated randomly (not using MongoDB's ID construction rules).
 * @locus Anywhere                                                                                                    // 642
 * @class                                                                                                             // 643
 * @param {String} hexString Optional.  The 24-character hexadecimal contents of the ObjectID to create               // 644
 */                                                                                                                   // 645
Mongo.ObjectID = LocalCollection._ObjectID;                                                                           // 646
                                                                                                                      // 647
/**                                                                                                                   // 648
 * @summary To create a cursor, use find. To access the documents in a cursor, use forEach, map, or fetch.            // 649
 * @class                                                                                                             // 650
 * @instanceName cursor                                                                                               // 651
 */                                                                                                                   // 652
Mongo.Cursor = LocalCollection.Cursor;                                                                                // 653
                                                                                                                      // 654
/**                                                                                                                   // 655
 * @deprecated in 0.9.1                                                                                               // 656
 */                                                                                                                   // 657
Mongo.Collection.Cursor = Mongo.Cursor;                                                                               // 658
                                                                                                                      // 659
/**                                                                                                                   // 660
 * @deprecated in 0.9.1                                                                                               // 661
 */                                                                                                                   // 662
Mongo.Collection.ObjectID = Mongo.ObjectID;                                                                           // 663
                                                                                                                      // 664
///                                                                                                                   // 665
/// Remote methods and access control.                                                                                // 666
///                                                                                                                   // 667
                                                                                                                      // 668
// Restrict default mutators on collection. allow() and deny() take the                                               // 669
// same options:                                                                                                      // 670
//                                                                                                                    // 671
// options.insert {Function(userId, doc)}                                                                             // 672
//   return true to allow/deny adding this document                                                                   // 673
//                                                                                                                    // 674
// options.update {Function(userId, docs, fields, modifier)}                                                          // 675
//   return true to allow/deny updating these documents.                                                              // 676
//   `fields` is passed as an array of fields that are to be modified                                                 // 677
//                                                                                                                    // 678
// options.remove {Function(userId, docs)}                                                                            // 679
//   return true to allow/deny removing these documents                                                               // 680
//                                                                                                                    // 681
// options.fetch {Array}                                                                                              // 682
//   Fields to fetch for these validators. If any call to allow or deny                                               // 683
//   does not have this option then all fields are loaded.                                                            // 684
//                                                                                                                    // 685
// allow and deny can be called multiple times. The validators are                                                    // 686
// evaluated as follows:                                                                                              // 687
// - If neither deny() nor allow() has been called on the collection,                                                 // 688
//   then the request is allowed if and only if the "insecure" smart                                                  // 689
//   package is in use.                                                                                               // 690
// - Otherwise, if any deny() function returns true, the request is denied.                                           // 691
// - Otherwise, if any allow() function returns true, the request is allowed.                                         // 692
// - Otherwise, the request is denied.                                                                                // 693
//                                                                                                                    // 694
// Meteor may call your deny() and allow() functions in any order, and may not                                        // 695
// call all of them if it is able to make a decision without calling them all                                         // 696
// (so don't include side effects).                                                                                   // 697
                                                                                                                      // 698
(function () {                                                                                                        // 699
  var addValidator = function(allowOrDeny, options) {                                                                 // 700
    // validate keys                                                                                                  // 701
    var VALID_KEYS = ['insert', 'update', 'remove', 'fetch', 'transform'];                                            // 702
    _.each(_.keys(options), function (key) {                                                                          // 703
      if (!_.contains(VALID_KEYS, key))                                                                               // 704
        throw new Error(allowOrDeny + ": Invalid key: " + key);                                                       // 705
    });                                                                                                               // 706
                                                                                                                      // 707
    var self = this;                                                                                                  // 708
    self._restricted = true;                                                                                          // 709
                                                                                                                      // 710
    _.each(['insert', 'update', 'remove'], function (name) {                                                          // 711
      if (options[name]) {                                                                                            // 712
        if (!(options[name] instanceof Function)) {                                                                   // 713
          throw new Error(allowOrDeny + ": Value for `" + name + "` must be a function");                             // 714
        }                                                                                                             // 715
                                                                                                                      // 716
        // If the transform is specified at all (including as 'null') in this                                         // 717
        // call, then take that; otherwise, take the transform from the                                               // 718
        // collection.                                                                                                // 719
        if (options.transform === undefined) {                                                                        // 720
          options[name].transform = self._transform;  // already wrapped                                              // 721
        } else {                                                                                                      // 722
          options[name].transform = LocalCollection.wrapTransform(                                                    // 723
            options.transform);                                                                                       // 724
        }                                                                                                             // 725
                                                                                                                      // 726
        self._validators[name][allowOrDeny].push(options[name]);                                                      // 727
      }                                                                                                               // 728
    });                                                                                                               // 729
                                                                                                                      // 730
    // Only update the fetch fields if we're passed things that affect                                                // 731
    // fetching. This way allow({}) and allow({insert: f}) don't result in                                            // 732
    // setting fetchAllFields                                                                                         // 733
    if (options.update || options.remove || options.fetch) {                                                          // 734
      if (options.fetch && !(options.fetch instanceof Array)) {                                                       // 735
        throw new Error(allowOrDeny + ": Value for `fetch` must be an array");                                        // 736
      }                                                                                                               // 737
      self._updateFetch(options.fetch);                                                                               // 738
    }                                                                                                                 // 739
  };                                                                                                                  // 740
                                                                                                                      // 741
  /**                                                                                                                 // 742
   * @summary Allow users to write directly to this collection from client code, subject to limitations you define.   // 743
   * @locus Server                                                                                                    // 744
   * @param {Object} options                                                                                          // 745
   * @param {Function} options.insert,update,remove Functions that look at a proposed modification to the database and return true if it should be allowed.
   * @param {String[]} options.fetch Optional performance enhancement. Limits the fields that will be fetched from the database for inspection by your `update` and `remove` functions.
   * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections).  Pass `null` to disable transformation.
   */                                                                                                                 // 749
  Mongo.Collection.prototype.allow = function(options) {                                                              // 750
    addValidator.call(this, 'allow', options);                                                                        // 751
  };                                                                                                                  // 752
                                                                                                                      // 753
  /**                                                                                                                 // 754
   * @summary Override `allow` rules.                                                                                 // 755
   * @locus Server                                                                                                    // 756
   * @param {Object} options                                                                                          // 757
   * @param {Function} options.insert,update,remove Functions that look at a proposed modification to the database and return true if it should be denied, even if an [allow](#allow) rule says otherwise.
   * @param {String[]} options.fetch Optional performance enhancement. Limits the fields that will be fetched from the database for inspection by your `update` and `remove` functions.
   * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections).  Pass `null` to disable transformation.
   */                                                                                                                 // 761
  Mongo.Collection.prototype.deny = function(options) {                                                               // 762
    addValidator.call(this, 'deny', options);                                                                         // 763
  };                                                                                                                  // 764
})();                                                                                                                 // 765
                                                                                                                      // 766
                                                                                                                      // 767
Mongo.Collection.prototype._defineMutationMethods = function() {                                                      // 768
  var self = this;                                                                                                    // 769
                                                                                                                      // 770
  // set to true once we call any allow or deny methods. If true, use                                                 // 771
  // allow/deny semantics. If false, use insecure mode semantics.                                                     // 772
  self._restricted = false;                                                                                           // 773
                                                                                                                      // 774
  // Insecure mode (default to allowing writes). Defaults to 'undefined' which                                        // 775
  // means insecure iff the insecure package is loaded. This property can be                                          // 776
  // overriden by tests or packages wishing to change insecure mode behavior of                                       // 777
  // their collections.                                                                                               // 778
  self._insecure = undefined;                                                                                         // 779
                                                                                                                      // 780
  self._validators = {                                                                                                // 781
    insert: {allow: [], deny: []},                                                                                    // 782
    update: {allow: [], deny: []},                                                                                    // 783
    remove: {allow: [], deny: []},                                                                                    // 784
    upsert: {allow: [], deny: []}, // dummy arrays; can't set these!                                                  // 785
    fetch: [],                                                                                                        // 786
    fetchAllFields: false                                                                                             // 787
  };                                                                                                                  // 788
                                                                                                                      // 789
  if (!self._name)                                                                                                    // 790
    return; // anonymous collection                                                                                   // 791
                                                                                                                      // 792
  // XXX Think about method namespacing. Maybe methods should be                                                      // 793
  // "Meteor:Mongo:insert/NAME"?                                                                                      // 794
  self._prefix = '/' + self._name + '/';                                                                              // 795
                                                                                                                      // 796
  // mutation methods                                                                                                 // 797
  if (self._connection) {                                                                                             // 798
    var m = {};                                                                                                       // 799
                                                                                                                      // 800
    _.each(['insert', 'update', 'remove'], function (method) {                                                        // 801
      m[self._prefix + method] = function (/* ... */) {                                                               // 802
        // All the methods do their own validation, instead of using check().                                         // 803
        check(arguments, [Match.Any]);                                                                                // 804
        var args = _.toArray(arguments);                                                                              // 805
        try {                                                                                                         // 806
          // For an insert, if the client didn't specify an _id, generate one                                         // 807
          // now; because this uses DDP.randomStream, it will be consistent with                                      // 808
          // what the client generated. We generate it now rather than later so                                       // 809
          // that if (eg) an allow/deny rule does an insert to the same                                               // 810
          // collection (not that it really should), the generated _id will                                           // 811
          // still be the first use of the stream and will be consistent.                                             // 812
          //                                                                                                          // 813
          // However, we don't actually stick the _id onto the document yet,                                          // 814
          // because we want allow/deny rules to be able to differentiate                                             // 815
          // between arbitrary client-specified _id fields and merely                                                 // 816
          // client-controlled-via-randomSeed fields.                                                                 // 817
          var generatedId = null;                                                                                     // 818
          if (method === "insert" && !_.has(args[0], '_id')) {                                                        // 819
            generatedId = self._makeNewID();                                                                          // 820
          }                                                                                                           // 821
                                                                                                                      // 822
          if (this.isSimulation) {                                                                                    // 823
            // In a client simulation, you can do any mutation (even with a                                           // 824
            // complex selector).                                                                                     // 825
            if (generatedId !== null)                                                                                 // 826
              args[0]._id = generatedId;                                                                              // 827
            return self._collection[method].apply(                                                                    // 828
              self._collection, args);                                                                                // 829
          }                                                                                                           // 830
                                                                                                                      // 831
          // This is the server receiving a method call from the client.                                              // 832
                                                                                                                      // 833
          // We don't allow arbitrary selectors in mutations from the client: only                                    // 834
          // single-ID selectors.                                                                                     // 835
          if (method !== 'insert')                                                                                    // 836
            throwIfSelectorIsNotId(args[0], method);                                                                  // 837
                                                                                                                      // 838
          if (self._restricted) {                                                                                     // 839
            // short circuit if there is no way it will pass.                                                         // 840
            if (self._validators[method].allow.length === 0) {                                                        // 841
              throw new Meteor.Error(                                                                                 // 842
                403, "Access denied. No allow validators set on restricted " +                                        // 843
                  "collection for method '" + method + "'.");                                                         // 844
            }                                                                                                         // 845
                                                                                                                      // 846
            var validatedMethodName =                                                                                 // 847
                  '_validated' + method.charAt(0).toUpperCase() + method.slice(1);                                    // 848
            args.unshift(this.userId);                                                                                // 849
            method === 'insert' && args.push(generatedId);                                                            // 850
            return self[validatedMethodName].apply(self, args);                                                       // 851
          } else if (self._isInsecure()) {                                                                            // 852
            if (generatedId !== null)                                                                                 // 853
              args[0]._id = generatedId;                                                                              // 854
            // In insecure mode, allow any mutation (with a simple selector).                                         // 855
            // XXX This is kind of bogus.  Instead of blindly passing whatever                                        // 856
            //     we get from the network to this function, we should actually                                       // 857
            //     know the correct arguments for the function and pass just                                          // 858
            //     them.  For example, if you have an extraneous extra null                                           // 859
            //     argument and this is Mongo on the server, the .wrapAsync'd                                         // 860
            //     functions like update will get confused and pass the                                               // 861
            //     "fut.resolver()" in the wrong slot, where _update will never                                       // 862
            //     invoke it. Bam, broken DDP connection.  Probably should just                                       // 863
            //     take this whole method and write it three times, invoking                                          // 864
            //     helpers for the common code.                                                                       // 865
            return self._collection[method].apply(self._collection, args);                                            // 866
          } else {                                                                                                    // 867
            // In secure mode, if we haven't called allow or deny, then nothing                                       // 868
            // is permitted.                                                                                          // 869
            throw new Meteor.Error(403, "Access denied");                                                             // 870
          }                                                                                                           // 871
        } catch (e) {                                                                                                 // 872
          if (e.name === 'MongoError' || e.name === 'MinimongoError') {                                               // 873
            throw new Meteor.Error(409, e.toString());                                                                // 874
          } else {                                                                                                    // 875
            throw e;                                                                                                  // 876
          }                                                                                                           // 877
        }                                                                                                             // 878
      };                                                                                                              // 879
    });                                                                                                               // 880
    // Minimongo on the server gets no stubs; instead, by default                                                     // 881
    // it wait()s until its result is ready, yielding.                                                                // 882
    // This matches the behavior of macromongo on the server better.                                                  // 883
    // XXX see #MeteorServerNull                                                                                      // 884
    if (Meteor.isClient || self._connection === Meteor.server)                                                        // 885
      self._connection.methods(m);                                                                                    // 886
  }                                                                                                                   // 887
};                                                                                                                    // 888
                                                                                                                      // 889
                                                                                                                      // 890
Mongo.Collection.prototype._updateFetch = function (fields) {                                                         // 891
  var self = this;                                                                                                    // 892
                                                                                                                      // 893
  if (!self._validators.fetchAllFields) {                                                                             // 894
    if (fields) {                                                                                                     // 895
      self._validators.fetch = _.union(self._validators.fetch, fields);                                               // 896
    } else {                                                                                                          // 897
      self._validators.fetchAllFields = true;                                                                         // 898
      // clear fetch just to make sure we don't accidentally read it                                                  // 899
      self._validators.fetch = null;                                                                                  // 900
    }                                                                                                                 // 901
  }                                                                                                                   // 902
};                                                                                                                    // 903
                                                                                                                      // 904
Mongo.Collection.prototype._isInsecure = function () {                                                                // 905
  var self = this;                                                                                                    // 906
  if (self._insecure === undefined)                                                                                   // 907
    return !!Package.insecure;                                                                                        // 908
  return self._insecure;                                                                                              // 909
};                                                                                                                    // 910
                                                                                                                      // 911
var docToValidate = function (validator, doc, generatedId) {                                                          // 912
  var ret = doc;                                                                                                      // 913
  if (validator.transform) {                                                                                          // 914
    ret = EJSON.clone(doc);                                                                                           // 915
    // If you set a server-side transform on your collection, then you don't get                                      // 916
    // to tell the difference between "client specified the ID" and "server                                           // 917
    // generated the ID", because transforms expect to get _id.  If you want to                                       // 918
    // do that check, you can do it with a specific                                                                   // 919
    // `C.allow({insert: f, transform: null})` validator.                                                             // 920
    if (generatedId !== null) {                                                                                       // 921
      ret._id = generatedId;                                                                                          // 922
    }                                                                                                                 // 923
    ret = validator.transform(ret);                                                                                   // 924
  }                                                                                                                   // 925
  return ret;                                                                                                         // 926
};                                                                                                                    // 927
                                                                                                                      // 928
Mongo.Collection.prototype._validatedInsert = function (userId, doc,                                                  // 929
                                                         generatedId) {                                               // 930
  var self = this;                                                                                                    // 931
                                                                                                                      // 932
  // call user validators.                                                                                            // 933
  // Any deny returns true means denied.                                                                              // 934
  if (_.any(self._validators.insert.deny, function(validator) {                                                       // 935
    return validator(userId, docToValidate(validator, doc, generatedId));                                             // 936
  })) {                                                                                                               // 937
    throw new Meteor.Error(403, "Access denied");                                                                     // 938
  }                                                                                                                   // 939
  // Any allow returns true means proceed. Throw error if they all fail.                                              // 940
  if (_.all(self._validators.insert.allow, function(validator) {                                                      // 941
    return !validator(userId, docToValidate(validator, doc, generatedId));                                            // 942
  })) {                                                                                                               // 943
    throw new Meteor.Error(403, "Access denied");                                                                     // 944
  }                                                                                                                   // 945
                                                                                                                      // 946
  // If we generated an ID above, insert it now: after the validation, but                                            // 947
  // before actually inserting.                                                                                       // 948
  if (generatedId !== null)                                                                                           // 949
    doc._id = generatedId;                                                                                            // 950
                                                                                                                      // 951
  self._collection.insert.call(self._collection, doc);                                                                // 952
};                                                                                                                    // 953
                                                                                                                      // 954
var transformDoc = function (validator, doc) {                                                                        // 955
  if (validator.transform)                                                                                            // 956
    return validator.transform(doc);                                                                                  // 957
  return doc;                                                                                                         // 958
};                                                                                                                    // 959
                                                                                                                      // 960
// Simulate a mongo `update` operation while validating that the access                                               // 961
// control rules set by calls to `allow/deny` are satisfied. If all                                                   // 962
// pass, rewrite the mongo operation to use $in to set the list of                                                    // 963
// document ids to change ##ValidatedChange                                                                           // 964
Mongo.Collection.prototype._validatedUpdate = function(                                                               // 965
    userId, selector, mutator, options) {                                                                             // 966
  var self = this;                                                                                                    // 967
                                                                                                                      // 968
  check(mutator, Object);                                                                                             // 969
                                                                                                                      // 970
  options = _.clone(options) || {};                                                                                   // 971
                                                                                                                      // 972
  if (!LocalCollection._selectorIsIdPerhapsAsObject(selector))                                                        // 973
    throw new Error("validated update should be of a single ID");                                                     // 974
                                                                                                                      // 975
  // We don't support upserts because they don't fit nicely into allow/deny                                           // 976
  // rules.                                                                                                           // 977
  if (options.upsert)                                                                                                 // 978
    throw new Meteor.Error(403, "Access denied. Upserts not " +                                                       // 979
                           "allowed in a restricted collection.");                                                    // 980
                                                                                                                      // 981
  var noReplaceError = "Access denied. In a restricted collection you can only" +                                     // 982
        " update documents, not replace them. Use a Mongo update operator, such " +                                   // 983
        "as '$set'.";                                                                                                 // 984
                                                                                                                      // 985
  // compute modified fields                                                                                          // 986
  var fields = [];                                                                                                    // 987
  if (_.isEmpty(mutator)) {                                                                                           // 988
    throw new Meteor.Error(403, noReplaceError);                                                                      // 989
  }                                                                                                                   // 990
  _.each(mutator, function (params, op) {                                                                             // 991
    if (op.charAt(0) !== '$') {                                                                                       // 992
      throw new Meteor.Error(403, noReplaceError);                                                                    // 993
    } else if (!_.has(ALLOWED_UPDATE_OPERATIONS, op)) {                                                               // 994
      throw new Meteor.Error(                                                                                         // 995
        403, "Access denied. Operator " + op + " not allowed in a restricted collection.");                           // 996
    } else {                                                                                                          // 997
      _.each(_.keys(params), function (field) {                                                                       // 998
        // treat dotted fields as if they are replacing their                                                         // 999
        // top-level part                                                                                             // 1000
        if (field.indexOf('.') !== -1)                                                                                // 1001
          field = field.substring(0, field.indexOf('.'));                                                             // 1002
                                                                                                                      // 1003
        // record the field we are trying to change                                                                   // 1004
        if (!_.contains(fields, field))                                                                               // 1005
          fields.push(field);                                                                                         // 1006
      });                                                                                                             // 1007
    }                                                                                                                 // 1008
  });                                                                                                                 // 1009
                                                                                                                      // 1010
  var findOptions = {transform: null};                                                                                // 1011
  if (!self._validators.fetchAllFields) {                                                                             // 1012
    findOptions.fields = {};                                                                                          // 1013
    _.each(self._validators.fetch, function(fieldName) {                                                              // 1014
      findOptions.fields[fieldName] = 1;                                                                              // 1015
    });                                                                                                               // 1016
  }                                                                                                                   // 1017
                                                                                                                      // 1018
  var doc = self._collection.findOne(selector, findOptions);                                                          // 1019
  if (!doc)  // none satisfied!                                                                                       // 1020
    return 0;                                                                                                         // 1021
                                                                                                                      // 1022
  var factoriedDoc;                                                                                                   // 1023
                                                                                                                      // 1024
  // call user validators.                                                                                            // 1025
  // Any deny returns true means denied.                                                                              // 1026
  if (_.any(self._validators.update.deny, function(validator) {                                                       // 1027
    if (!factoriedDoc)                                                                                                // 1028
      factoriedDoc = transformDoc(validator, doc);                                                                    // 1029
    return validator(userId,                                                                                          // 1030
                     factoriedDoc,                                                                                    // 1031
                     fields,                                                                                          // 1032
                     mutator);                                                                                        // 1033
  })) {                                                                                                               // 1034
    throw new Meteor.Error(403, "Access denied");                                                                     // 1035
  }                                                                                                                   // 1036
  // Any allow returns true means proceed. Throw error if they all fail.                                              // 1037
  if (_.all(self._validators.update.allow, function(validator) {                                                      // 1038
    if (!factoriedDoc)                                                                                                // 1039
      factoriedDoc = transformDoc(validator, doc);                                                                    // 1040
    return !validator(userId,                                                                                         // 1041
                      factoriedDoc,                                                                                   // 1042
                      fields,                                                                                         // 1043
                      mutator);                                                                                       // 1044
  })) {                                                                                                               // 1045
    throw new Meteor.Error(403, "Access denied");                                                                     // 1046
  }                                                                                                                   // 1047
                                                                                                                      // 1048
  options._forbidReplace = true;                                                                                      // 1049
                                                                                                                      // 1050
  // Back when we supported arbitrary client-provided selectors, we actually                                          // 1051
  // rewrote the selector to include an _id clause before passing to Mongo to                                         // 1052
  // avoid races, but since selector is guaranteed to already just be an ID, we                                       // 1053
  // don't have to any more.                                                                                          // 1054
                                                                                                                      // 1055
  return self._collection.update.call(                                                                                // 1056
    self._collection, selector, mutator, options);                                                                    // 1057
};                                                                                                                    // 1058
                                                                                                                      // 1059
// Only allow these operations in validated updates. Specifically                                                     // 1060
// whitelist operations, rather than blacklist, so new complex                                                        // 1061
// operations that are added aren't automatically allowed. A complex                                                  // 1062
// operation is one that does more than just modify its target                                                        // 1063
// field. For now this contains all update operations except '$rename'.                                               // 1064
// http://docs.mongodb.org/manual/reference/operators/#update                                                         // 1065
var ALLOWED_UPDATE_OPERATIONS = {                                                                                     // 1066
  $inc:1, $set:1, $unset:1, $addToSet:1, $pop:1, $pullAll:1, $pull:1,                                                 // 1067
  $pushAll:1, $push:1, $bit:1                                                                                         // 1068
};                                                                                                                    // 1069
                                                                                                                      // 1070
// Simulate a mongo `remove` operation while validating access control                                                // 1071
// rules. See #ValidatedChange                                                                                        // 1072
Mongo.Collection.prototype._validatedRemove = function(userId, selector) {                                            // 1073
  var self = this;                                                                                                    // 1074
                                                                                                                      // 1075
  var findOptions = {transform: null};                                                                                // 1076
  if (!self._validators.fetchAllFields) {                                                                             // 1077
    findOptions.fields = {};                                                                                          // 1078
    _.each(self._validators.fetch, function(fieldName) {                                                              // 1079
      findOptions.fields[fieldName] = 1;                                                                              // 1080
    });                                                                                                               // 1081
  }                                                                                                                   // 1082
                                                                                                                      // 1083
  var doc = self._collection.findOne(selector, findOptions);                                                          // 1084
  if (!doc)                                                                                                           // 1085
    return 0;                                                                                                         // 1086
                                                                                                                      // 1087
  // call user validators.                                                                                            // 1088
  // Any deny returns true means denied.                                                                              // 1089
  if (_.any(self._validators.remove.deny, function(validator) {                                                       // 1090
    return validator(userId, transformDoc(validator, doc));                                                           // 1091
  })) {                                                                                                               // 1092
    throw new Meteor.Error(403, "Access denied");                                                                     // 1093
  }                                                                                                                   // 1094
  // Any allow returns true means proceed. Throw error if they all fail.                                              // 1095
  if (_.all(self._validators.remove.allow, function(validator) {                                                      // 1096
    return !validator(userId, transformDoc(validator, doc));                                                          // 1097
  })) {                                                                                                               // 1098
    throw new Meteor.Error(403, "Access denied");                                                                     // 1099
  }                                                                                                                   // 1100
                                                                                                                      // 1101
  // Back when we supported arbitrary client-provided selectors, we actually                                          // 1102
  // rewrote the selector to {_id: {$in: [ids that we found]}} before passing to                                      // 1103
  // Mongo to avoid races, but since selector is guaranteed to already just be                                        // 1104
  // an ID, we don't have to any more.                                                                                // 1105
                                                                                                                      // 1106
  return self._collection.remove.call(self._collection, selector);                                                    // 1107
};                                                                                                                    // 1108
                                                                                                                      // 1109
/**                                                                                                                   // 1110
 * @deprecated in 0.9.1                                                                                               // 1111
 */                                                                                                                   // 1112
Meteor.Collection = Mongo.Collection;                                                                                 // 1113
                                                                                                                      // 1114
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package.mongo = {
  MongoInternals: MongoInternals,
  MongoTest: MongoTest,
  Mongo: Mongo
};

})();

//# sourceMappingURL=mongo.js.map
