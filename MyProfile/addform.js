if(Meteor.isClient) {
    Session.setDefault("form", false);

    Template.addform.events({
        'click .save': function (evt, tmpl) {
            var name = tmpl.find('.name').value;
            var description = tmpl.find('.description').value;
            var url = tmpl.find('.src').value;
            var height = getRandomInt(100, 350);
            Meteor.call("addboards", name, description, url);
            Session.set("form", false);
        },
        'click .cancel': function () {
            Session.set('form', false);
        }

    })
    // Random integer function for random height of article

    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) * min;
    }

}
