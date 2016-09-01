var firebase = require('firebase');

firebase.initializeApp({
  serviceAccount: "athome-scrapper-8be17f7116fe.json",
  databaseURL: "https://athome-scrapper.firebaseio.com"
});

var db = firebase.database();
var announcers = db.ref("athome-announcers");

announcers.set(
    {
        socoma : {
            url: "http://www.athome.lu/agence/socoma-construction/strassen/27626/p/1",
            crawlPattern: "(https?:\/\/www.athome.lu)?\/agence\/socoma-construction\/strassen\/27626\/p\/[0-9]*#?.*",
        }
    }
);