"use strict";

const settings = require("../settings.json");

if (settings.api.client.oauth2.link.slice(-1) == "/")
  settings.api.client.oauth2.link = settings.api.client.oauth2.link.slice(0, -1);

if (settings.api.client.oauth2.callbackpath.slice(0, 1) !== "/")
  settings.api.client.oauth2.callbackpath = "/" + settings.api.client.oauth2.callbackpath;

if (settings.pterodactyl.domain.slice(-1) == "/")
  settings.pterodactyl.domain = settings.pterodactyl.domain.slice(0, -1);

const fetch = require('node-fetch');

const indexjs = require("../index.js");

const fs = require("fs");

module.exports.load = async function(app, db) {
  app.get("/login", async (req, res) => {
    if (req.query.redirect) req.session.redirect = "/" + req.query.redirect;
    let newsettings = JSON.parse(fs.readFileSync("./settings.json"));
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${settings.api.client.oauth2.id}&redirect_uri=${encodeURIComponent(settings.api.client.oauth2.link + settings.api.client.oauth2.callbackpath)}&response_type=code&scope=identify%20email${newsettings.api.client.bot.joinguild.enabled == true ? "%20guilds.join" : ""}${settings.api.client.oauth2.prompt == false ? "&prompt=none" : (req.query.prompt ? (req.query.prompt == "none" ? "&prompt=none" : "") : "")}`);
  });

  app.get("/logout", (req, res) => {
    let theme = indexjs.get(req);
    req.session.destroy(() => {
      return res.redirect(theme.settings.redirect.logout ? theme.settings.redirect.logout : "/");
    });
  });

  app.get(settings.api.client.oauth2.callbackpath, async (req, res) => {
    let theme = indexjs.get(req);
    let customredirect = req.session.redirect;
    delete req.session.redirect;
    let failedcallback = theme.settings.redirect.failedcallback ? theme.settings.redirect.failedcallback : "/";
    if (!req.query.code) return res.redirect(failedcallback + "?err=MISSINGCODE");
    let json = await fetch(
      'https://discord.com/api/oauth2/token',
      {
        method: "post",
        body: "client_id=" + settings.api.client.oauth2.id + "&client_secret=" + settings.api.client.oauth2.secret + "&grant_type=authorization_code&code=" + encodeURIComponent(req.query.code) + "&redirect_uri=" + encodeURIComponent(settings.api.client.oauth2.link + settings.api.client.oauth2.callbackpath),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    if (json.ok == true) {
      let codeinfo = JSON.parse(await json.text());
      let scopes = codeinfo.scope;
      let missingscopes = [];
      let newsettings = JSON.parse(fs.readFileSync("./settings.json"));

      if (scopes.replace(/identify/g, "") == scopes) missingscopes.push("identify");
      if (scopes.replace(/email/g, "") == scopes) missingscopes.push("email");
      if (newsettings.api.client.bot.joinguild.enabled == true) if (scopes.replace(/guilds.join/g, "") == scopes) missingscopes.push("guilds.join");
      if (missingscopes.length !== 0) return res.redirect(failedcallback + "?err=MISSINGSCOPES&scopes=" + missingscopes.join("%20"));
      let userjson = await fetch(
        'https://discord.com/api/users/@me',
        {
          method: "get",
          headers: {
            "Authorization": `Bearer ${codeinfo.access_token}`
          }
        }
      );
      let userinfo = JSON.parse(await userjson.text());
      if (userinfo.verified == true) {
        
        let ip = (newsettings.api.client.oauth2.ip["trust x-forwarded-for"] == true ? (req.headers['x-forwarded-for'] || req.connection.remoteAddress) : req.connection.remoteAddress);
        ip = (ip ? ip : "::1").replace(/::1/g, "::ffff:127.0.0.1").replace(/^.*:/, '');
        
        if (newsettings.api.client.oauth2.ip.block.includes(ip)) return res.redirect(failedcallback + "?err=IPBLOCKED")

        if (newsettings.api.client.oauth2.ip["duplicate check"] == true) {
          let allips = await db.get("ips") ? await db.get("ips") : [];
          let mainip = await db.get("ip-" + userinfo.id);
          if (mainip) {
            if (mainip !== ip) {
              allips = allips.filter(ip2 => ip2 !== mainip);
              if (allips.includes(ip)) {
                return res.redirect(failedcallback + "?err=ANTIALT")
              }
              allips.push(ip);
              await db.set("ips", allips);
              await db.set("ip-" + userinfo.id, ip);
            }
          } else {
            if (allips.includes(ip)) {
              return res.redirect(failedcallback + "?err=ANTIALT")
            }
            allips.push(ip);
            await db.set("ips", allips);
            await db.set("ip-" + userinfo.id, ip);
          }
        }

        if (newsettings.api.client.bot.joinguild.enabled == true) {
          if (typeof newsettings.api.client.bot.joinguild.guildid == "string") {
            await fetch(
              `https://discord.com/api/guilds/${newsettings.api.client.bot.joinguild.guildid}/members/${userinfo.id}`,
              {
                method: "put",
                headers: {
                  'Content-Type': 'application/json',
                  "Authorization": `Bot ${newsettings.api.client.bot.token}`
                },
                body: JSON.stringify({
                  access_token: codeinfo.access_token
                })
              }
            );  
          } else if (typeof newsettings.api.client.bot.joinguild.guildid == "object") {
            if (Array.isArray(newsettings.api.client.bot.joinguild.guildid)) {
              for (let guild of newsettings.api.client.bot.joinguild.guildid) {
                await fetch(
                  `https://discord.com/api/guilds/${guild}/members/${userinfo.id}`,
                  {
                    method: "put",
                    headers: {
                      'Content-Type': 'application/json',
                      "Authorization": `Bot ${newsettings.api.client.bot.token}`
                    },
                    body: JSON.stringify({
                      access_token: codeinfo.access_token
                    })
                  }
                );  
              }
            } else {
              return res.send("Tell an administrator there is an error settings.json: api.client.bot.joinguild.guildid is not an array nor a string.");
            }
          } else {
            return res.send("Tell an administrator there is an error settings.json: api.client.bot.joinguild.guildid is not an array nor a string.");
          }
        }
        if (!await db.get("users-" + userinfo.id)) {
          if (newsettings.api.client.allow.newusers == true) {
            let genpassword = null;
            if (newsettings.api.client.passwordgenerator.signup == true) genpassword = makeid(newsettings.api.client.passwordgenerator["length"]);
            let accountjson = await fetch(
              settings.pterodactyl.domain + "/api/application/users",
              {
                method: "post",
                headers: {
                  'Content-Type': 'application/json',
                  "Authorization": `Bearer ${settings.pterodactyl.key}`
                },
                body: JSON.stringify({
                  username: userinfo.id,
                  email: userinfo.email,
                  first_name: userinfo.username,
                  last_name: "#" + userinfo.discriminator,
                  password: genpassword
                })
              }
            );
            if (await accountjson.status == 201) {
              let accountinfo = JSON.parse(await accountjson.text());
              let userids = await db.get("users") ? await db.get("users") : [];
              userids.push(accountinfo.attributes.id);
              await db.set("users", userids);
              await db.set("users-" + userinfo.id, accountinfo.attributes.id);
              req.session.newaccount = true;
              req.session.password = genpassword;
            } else {
              let accountlistjson = await fetch(
                settings.pterodactyl.domain + "/api/application/users?include=servers&filter[email]=" + encodeURIComponent(userinfo.email),
                {
                  method: "get",
                  headers: {
                    'Content-Type': 'application/json',
                    "Authorization": `Bearer ${settings.pterodactyl.key}`
                  }
                }
              );
              let accountlist = await accountlistjson.json();
              let user = accountlist.data.filter(acc => acc.attributes.email == userinfo.email);
              if (user.length == 1) {
                let userid = user[0].attributes.id;
                let userids = await db.get("users") ? await db.get("users") : [];
                if (userids.filter(id => id == userid).length == 0) {
                  userids.push(userid);
                  await db.set("users", userids);
                  await db.set("users-" + userinfo.id, userid);
                  req.session.pterodactyl = user[0].attributes;
                } else {
                  return res.redirect(failedcallback + "?err=ANOTHERACCOUNT");
                }
              } else {
                return res.redirect(failedcallback + "?err=UNKNOWN");
              };
            };
          } else {
            return res.redirect(failedcallback + "?err=DISABLED")
          }
        };

        let cacheaccount = await fetch(
          settings.pterodactyl.domain + "/api/application/users/" + (await db.get("users-" + userinfo.id)) + "?include=servers",
          {
            method: "get",
            headers: { 'Content-Type': 'application/json', "Authorization": `Bearer ${settings.pterodactyl.key}` }
          }
        );
        if (await cacheaccount.statusText == "Not Found") return res.redirect(failedcallback + "?err=CANNOTGETINFO");
        let cacheaccountinfo = JSON.parse(await cacheaccount.text());
        req.session.pterodactyl = cacheaccountinfo.attributes;

        req.session.userinfo = userinfo;

        if (customredirect) return res.redirect(customredirect);
        return res.redirect(theme.settings.redirect.callback ? theme.settings.redirect.callback : "/");
      };
      res.redirect(failedcallback + "?err=UNVERIFIED");
    } else {
      res.redirect(failedcallback + "?err=INVALIDCODE");
    };
  });
};

function makeid(length) {
  let result = '';
  let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
