(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var WebApp = Package.webapp.WebApp;
var main = Package.webapp.main;
var WebAppInternals = Package.webapp.WebAppInternals;

(function () {

/////////////////////////////////////////////////////////////////////////////
//                                                                         //
// packages/ecwyne:polymer-elements/handler.js                             //
//                                                                         //
/////////////////////////////////////////////////////////////////////////////
                                                                           //
WebApp.connectHandlers.use('/bower_components', function (req, res, next){ // 1
	Assets.getText('lib/bower_components' + req.url, function (err, file){    // 2
		if (err){                                                                // 3
			next();                                                                 // 4
		} else {                                                                 // 5
			res.writeHead(200, {'Content-Type': req.url.split('.')[1] == 'js' ? 'application/javascript' : 'text/' + req.url.split('.')[1]});
			res.write(file);                                                        // 7
			res.end();                                                              // 8
		}                                                                        // 9
	});                                                                       // 10
});                                                                        // 11
                                                                           // 12
/////////////////////////////////////////////////////////////////////////////

}).call(this);


/* Exports */
if (typeof Package === 'undefined') Package = {};
Package['ecwyne:polymer-elements'] = {};

})();

//# sourceMappingURL=ecwyne_polymer-elements.js.map
