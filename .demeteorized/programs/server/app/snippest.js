(function(){//  Client Code

if (Meteor.isClient) {

    Meteor.subscribe("likes");


    Session.setDefault("form", false);

    Accounts.ui.config({
        passwordSignupFields: 'USERNAME_AND_OPTIONAL_EMAIL'
    });

    Router.route('/', function () {
        this.render('explorer');
    });


    Router.route('/friends', function () {
        this.render('friends');
    });


    Router.route('/myprofile', function () {
        this.render('myprofile');
    });
    //router for interests
    Router.map(function () {
        this.route('interests', {
            path: '/interests',

            data: {
                posts: [
                    {
                        title: 'Did you know that...',
                        text: 'If you yelled for 8 years, 7 months and 6 days, you would have produced enough sound energy to heat up one cup of coffee.'
                    },
                    {
                        title: 'Hello World',
                        text: 'Hi, i am new here!'
                    }
                ]
            }
        });
    });


    Router.route('/pages', function () {
        this.layout('ApplicationLayout');
        // render the Post template into the "main" region
        // {{> yield}}
        this.render('Post');

        // render the PostAside template into the yield region named "aside"
        // {{> yield "aside"}}
        this.render('PostAside', {to: 'aside'});

        // render the PostFooter template into the yield region named "footer"
        // {{> yield "footer"}}
        this.render('PostFooter', {to: 'footer'});

    });


    Router.route('/shopping', function () {
        this.render('layout1');
        this.render('products', {to: 'products'});
        this.render('categories', {to: 'categories'});

    });




    //application layout events
    //
    //Template.ApplicationLayout.events({
    //    'click .clickme': function () {
    //        Router.go('/pages/cat1');
    //
    //    }
    //
    //
    //});



    Template.myprofile.rendered = function () {

        setTimeout(function () {
            masonize(function () {
                $('.search-query').focus();
            })
        }, 500);
    }


    //masonize function
    function masonize(callback) {
        var container = $('mainContent');
        container.masonry({
            itemSelector: '.item',
            gutter: 20
        })
        if (callback) {
            callback()
        }
    };



    // router for shopping

    Router.map(function () {
        this.route('products', {
            path: "/:name",
            data: function () {
                console.log(this.params.name);
                Session.set('category', this.params.name);
            }

        });
    });


    Template.registerHelper('currency', function(num){
        return '$' + Number(num).toFixed(2);
    });


}











})();
