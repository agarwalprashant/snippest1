if(Meteor.isClient) {
    Template.nav.events({

        'click .minty': function () {
            Router.go('/');
        },

        'click .shoppingcart': function () {
            Router.go('/shopping');
        },

        'click #interests': function () {
            Router.go('/interests')
        },

        'click #friends': function () {
            Router.go('/friends');
        },
        'click .myprofile': function () {
            Router.go('/myprofile');
        },
        'click .pages': function () {
            Router.go('/pages');
        }


    });
}
