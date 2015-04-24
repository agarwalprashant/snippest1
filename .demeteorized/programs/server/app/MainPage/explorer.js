(function(){if(Meteor.isClient){

    Template.nyTimes.events ({

        'click .search': function (evt, tmpl) {
            var searchterm = tmpl.find('#searchterm').value;

            Meteor.call("search", searchterm);


        }
    });
    Meteor.methods({

        search: function search(searchterm) {
            var search_term = {
                q: searchterm
            };

            console.log('searching for');
            console.dir(search_term);
            $.ajax({
                url: 'http://api.nytimes.com/svc/search/v2/articlesearch.json?api-key=24bac03b73db4c3811f6939820a75a27:11:71486950&' + $.param(search_term),
                dataType: 'json',
                success: function (data) {
                    console.dir(data);
                    for (item in data['response']['docs']) {
                        $('#tweets').append(
                            '<li>' + data['response']['docs'][item]['snippet'] + '<li>'
                        );
                    }
                }
            });

        }
    });
}




})();
