require('dotenv').config();
// load libraries
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const { MongoClient } = require('mongodb');
const ObjectID = require('mongodb').ObjectID

const mysql = require('mysql2/promise');
const fs = require('fs');

const jwt = require('jsonwebtoken');
const passport = require('passport')
const FacebookStrategy = require('passport-facebook').Strategy;

const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
    host: process.env.NODEMAILER_HOST,
    port: process.env.NODEMAILER_PORT,
    secure: true,
    auth: {
      user: process.env.NODEMAILER_USER,
      pass: process.env.NODEMAILER_PASS
    }
  });

// configure environment
const PORT = parseInt(process.argv[2]) || parseInt(process.env.PORT) || 3000

// json web token
const TOKEN_SECRET = process.env.JWT_TOKEN_SECRET

// configure mongo
const MONGO_USER = process.env.MONGO_USER 
const MONGO_PASSWORD = process.env.MONGO_PASSWORD
// const MONGO_URL = 'mongodb://localhost:27017';
const MONGO_URL = process.env.MONGO_URI

const MONGO_DATABASE = 'snmf2020';
const MONGO_COLLECTION_RECIPES = 'recipes'
const MONGO_COLLECTION_RECIPE_PLAN = 'recipesplan'

const mongoClient = new MongoClient(MONGO_URL, 
    { useNewUrlParser: true, useUnifiedTopology: true }
)

// configure spoonacular api
const SPOON_APIKEY=process.env.SPOON_APIKEY
const SPOON_URL=process.env.SPOON_URL
const fetch = require('node-fetch');

// configure sql
const pool  = mysql.createPool({
    connectionLimit : process.env.MYSQL_CONNECTION,
    host            : process.env.MYSQL_SERVER,
    port            : process.env.MYSQL_PORT,
    user            : process.env.MYSQL_USERNAME,
    password        : process.env.MYSQL_PASSWORD,
    database        : process.env.MYSQL_DATABASE,
    timezone        : '+08:00',
    ssl             : {
                        ca : fs.readFileSync(__dirname + '/cert/ca-certificate.crt')
                    }
});

const SQL_GET_USER_DETAILS = `select * from recipeUser where email = ?`;
const SQL_GET_ALL_USER = `select * from recipeUser`;
const SQL_ADD_USER = `insert into recipeUser values (?,?,?);`;
const SQL_UPDATE_USER = `update recipeUser set role = ? where email = ?;`;
const SQL_DELETE_USER = `delete from recipeUser where email = ?;`;

const mkQuery = (sql, pool) => {
    return async (args) => {
        const conn = await pool.getConnection();
        try {
            const [result, _] = await conn.query(sql, args);
            return result
        } catch(err) {
            console.error('Error: ', err)
            throw err;
        } finally {
            conn.release();
        }
    }
}

const findUser = mkQuery(SQL_GET_USER_DETAILS, pool)
const adminGetAllUser = mkQuery(SQL_GET_ALL_USER, pool)
const adminAddUser = mkQuery(SQL_ADD_USER, pool)
const adminUpdateUser = mkQuery(SQL_UPDATE_USER, pool)
const adminDeleteUser = mkQuery(SQL_DELETE_USER, pool)

// configure facebook passport
passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: process.env.FACEBOOK_CALLBACK_URL,
    profileFields: ['id', 'emails', 'displayName']
  },
  function(accessToken, refreshToken, profile, done) {
      const name = profile.displayName;
      const email = profile.emails[0].value
      
      // check against SQL database
      findUser([email])
        .then((r) => {
            console.log('User found from SQL>>>> ', r)
            if (r.length > 0) {
                done(null, 
                    // info about the user to be passed to the application
                    {
                        name: name,
                        email: email,
                        role: r[0].role,
                        loginTime: (new Date()).toString(),
                        source: 'mysql',
                        avatar: `https://i.pravatar.cc/150?u=${email}`,
                        security: 2
                    })
                    return
                }
                done('User not registered, contact admin', false)
                })
        .catch((e) => {
            console.error(e)
        })
    }
));

// create express instance
const app = express()
app.use(morgan('combined'))
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended: true}))

// initialize passport after json and form-urlencoded
app.use(passport.initialize());

// configure routes



// FACEBOOK authentication routes
app.get('/auth/facebook', passport.authenticate('facebook', {scope : ['email'] }));

app.get('/auth/facebook/callback',
    // successRedirect: '/', failureRedirect: '/login', 
    passport.authenticate('facebook', {session: false}),
    (req, res) => {
        console.info(`User from facebook auth>>>> `, req.user)
        
        // generate JWT token
        const timestamp = (new Date()).getTime() / 1000;
        const token = jwt.sign({
            sub: req.user.email,
            iss: 'recipe-app',
            iat: timestamp,
            exp: timestamp + 60 * 60,
            data: {
                avatar: req.user.avatar,
                loginTime: req.user.loginTime,
                name: req.user.name
            }
        }, TOKEN_SECRET)
        console.info('JSON Web Token generated>>>> ', token)

        var responseHTML = '<html><head><title>Main</title></head><body></body><script>res = %value%; window.opener.postMessage(res, "*");window.close();</script></html>'
        responseHTML = responseHTML.replace('%value%', JSON.stringify({
            user: req.user,
            token
        }));
        res.status(200).send(responseHTML);
    }
);

// GET /api/spoon
app.get('/api/spoon', async (req, res) => {
    const query = req.query['q']
    const resultCount = '3'
    const instructionsRequired = 'true'
    let recipeDetails = []

    const url = `${SPOON_URL}/complexSearch/?apiKey=${SPOON_APIKEY}&query=${query}&number=${resultCount}&instructionsRequired=${instructionsRequired}`

    res.type('application/json')

    try {
    let result1 = await fetch(url)
    result1 = await result1.json()
    
    if (result1.results.length <= 0) {
        res.status(404);
        res.json({'msg': 'no result'});
    }

    for (i=0; i<result1.results.length; i++){
        let r = await fetch(`https://api.spoonacular.com/recipes/${result1.results[i].id}/information/?apiKey=${SPOON_APIKEY}`)
        r = await r.json()
        if(!r['image'])
            {r['image'] = 'assets/images/Cook-Book-placeholder.png'}
        r['showDetails'] = false;
        delete r['vegetarian']; delete r['vegan']; delete r['glutenFree']; delete r['dairyFree'];
        delete r['cheap']; delete r['sustainable']; delete r['weightWatcherSmartPoints'];
        delete r['gaps']; delete r['lowFodmap']; delete r['aggregateLikes']; delete r['spoonacularScore'];
        delete r['healthScore']; delete r['creditsText']; delete r['license']; delete r['sourceName'];
        delete r['pricePerServing']; delete r['imageType']; delete r['cuisines']; delete r['dishTypes'];
        delete r['diets']; delete r['occasions']; delete r['winePairing']; delete r['originalId']; delete r['author'];
        recipeDetails.push(r);
    }
    res.status(200)
    res.json({r: recipeDetails})
    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }
            
})

// GET /api/recipe
app.get('/api/recipe', async (req, res) => {

    try{
        const result = await mongoClient.db(MONGO_DATABASE)
            .collection(MONGO_COLLECTION_RECIPES)
            .find({
            })
            .sort({
                ts: -1
            })
            .toArray()

        res.type('application/json');
        res.status(200);
        res.json(result);

    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }
})

// POST /api/recipe
app.post('/api/recipe', async (req, res) => {
    
    const recipe = req.body.recipe
    res.type('application/json');
    try {
        const result = await mongoClient.db(MONGO_DATABASE)
            .collection(MONGO_COLLECTION_RECIPES)
            .find({
                id: recipe.id
            })
            .toArray()
        
        if (result.length<=0) {
            recipe['ts'] = new Date()

            const result = await mongoClient.db(MONGO_DATABASE)
            .collection(MONGO_COLLECTION_RECIPES)
            .insertOne(recipe)
        
            res.status(200);
            res.json(result);
        } 
        
        res.status(200);
        res.json({msg: "data already exists, not saved"});

    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }

})

// GET /api/recipeplan/:useremail
app.get('/api/recipeplan/:useremail', async (req, res) => {

    const useremail = req.params['useremail']

    try{
        const result = await mongoClient.db(MONGO_DATABASE)
            .collection(MONGO_COLLECTION_RECIPE_PLAN)
            .find({
                useremail: useremail
            })
            .toArray()

        res.type('application/json');
        res.status(200);
        res.json(result);

    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }
})

// POST /api/recipeplan
app.post('/api/recipeplan/:useremail', async (req, res) => {
    
    const recipe = req.body.recipeplan
    recipe['useremail'] = req.params.useremail
    delete recipe['username']
    delete recipe['useravatar']

    console.log('recipe to be added', recipe);
    res.type('application/json');
    try {
        recipe['ts'] = new Date()

        const result = await mongoClient.db(MONGO_DATABASE)
        .collection(MONGO_COLLECTION_RECIPE_PLAN)
        .insertOne(recipe)
    
        res.status(200);
        res.json(result);

    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }

})

// DELETE /api/recipeplan/:id
app.delete('/api/recipeplan/:oid', async (req, res) => {
    
    const o_id = new ObjectID(req.params.oid);


    res.type('application/json');
    try {

        const result = await mongoClient.db(MONGO_DATABASE)
        .collection(MONGO_COLLECTION_RECIPE_PLAN)
        .deleteOne({ "_id" : o_id })
    
        res.status(200);
        res.json(result);

    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }

})

// GET /api/ingredient/:useremail
app.get('/api/ingredient/:useremail', async(req, res) => {
    const useremail = req.params['useremail']
    try {

        const result = await mongoClient.db(MONGO_DATABASE)
        .collection(MONGO_COLLECTION_RECIPE_PLAN)
        .aggregate([
            {
                $match: {
                    useremail: useremail
                }
            },
            {
                $project: {
                    weekStart: 1,
                    extendedIngredients: 1,
                }
            },
            {
                $unwind: '$extendedIngredients'
            },
            {
                $project: {
                    weekStart:1,
                    name: "$extendedIngredients.name",
                    amount: "$extendedIngredients.amount",
                    unit: "$extendedIngredients.unit",
                }
            },
            {
                $group: {
                    _id: {
                        "weekStart": "$weekStart",
                        "name": "$name",
                        "unit": "$unit",                
                    },
                    totalAmount: { $sum: "$amount" }
                }
            },
            {
                $project: {
                    weekStart: "$_id.weekStart",
                    name: "$_id.name",
                    totalAmount: 1,
                    unit: "$_id.unit",
                    _id: 0
                }
            },
            {
                $group: {
                    _id: "$weekStart",
                    ingredients: { $push:  { name: "$name",unit: "$unit", totalAmount: "$totalAmount" } }
                }    
            }
        ]).toArray()

        res.type('application/json');
        res.status(200);
        res.json(result);


    } catch (e) {
        res.status(500);
        res.type('application/json');
        res.json({error: e});
    }
    
})

// routes for user admin
app.get('/api/admin', async (req, res) => {

    res.type('application/json');
    try {
        const result = await adminGetAllUser([])

        // check whether any user exists
        if (result.length <= 0) {
            res.status(401)
            res.json({ message: `No user found`})
            return
        }

        // user and password matches
        res.status(200)
        res.json({ result })

    } catch (e) {
        console.error(e)
        res.status(500).json({error: e});
    }

})

app.post('/api/admin', async (req, res) => {

    const email = req.body.email
    const role = req.body.role
    const name = req.body.name

    res.type('application/json');
    try {
        const result = await adminAddUser([email, role, name])

        const message = {
            from: process.env.NODEMAILER_USER, // Sender address
            to: email,         // List of recipients
            subject: `Welcome from My Cookbook's Team`, // Subject line
            html: `<h1>Hey ${name}, welcome on board!</h1><h3>Access the page now => <a href="https://gohts-recipebook.herokuapp.com/">Link</a></h3><p>You may search for recipe, add to your meal planner and share recipes with friends!</p>` // Plain text body
        };

        transport.sendMail(message, function(err, info) {
            if (err) {
              console.log(err)
            } else {
              console.log(info);
            }
        });

        // user and password matches
        res.status(200)
        res.json({ result })

    } catch (e) {
        console.error(e)
        res.status(500).json({error: e});
    }

})

app.put('/api/admin/:email', async (req, res) => {
    
    const role = req.body.role
    const email = req.params.email

    res.type('application/json');
    try {
        const result = await adminUpdateUser([role, email])

        // user and password matches
        res.status(200)
        res.json({ result })

    } catch (e) {
        console.error(e)
        res.status(500).json({error: e});
    }

})

app.delete('/api/admin/:email', async (req, res) => {
    
    const email = req.params.email

    res.type('application/json');
    try {

        const result_mongo = await mongoClient.db(MONGO_DATABASE)
        .collection(MONGO_COLLECTION_RECIPE_PLAN)
        .deleteMany({ "useremail" : email })

        const result_sql = await adminDeleteUser([email])

        // user and password matches
        res.status(200)
        res.json({ 'mongo': result_mongo, 'sql': 'result_sql' })

    } catch (e) {
        console.error(e)
        res.status(500).json({error: e});
    }

})

// load static resources
app.use(express.static(__dirname + '/frontend'))

// start the application
const p0 = (async () => {
    const conn = await pool.getConnection();
    await conn.ping()
    conn.release()
    return true
})();

const p1 = (async () => {
    await mongoClient.connect();
    return true
})();

Promise.all([ p0, p1 ])
    .then((r) => {
        app.listen(PORT, () => {
            console.info(`Application started on PORT: ${PORT} at ${new Date()}`);
        })
    })
    .catch(e => {
        console.error(`Cannot connect to database: `,e)
	});
