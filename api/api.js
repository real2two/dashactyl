const indexjs = require("../index.js");
const adminjs = require("./admin.js");
const fs = require("fs");
const ejs = require("ejs");
const fetch = require('node-fetch');
const default_package = { ram: 0, disk: 0, cpu: 0, servers: 0 };

module.exports.load = async function(app, db) {
    app.get("/api", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;
        res.json({ "status": true });
    });

    app.get("/api/userinfo/:id", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;
        if (!req.params.id) return res.json({ status: "missing id" });

        if (!(await db.get("users-" + req.params.id))) return res.send({ status: "invalid id" });
        let newsettings = JSON.parse(fs.readFileSync("./settings.json").toString());

        if (newsettings.api.client.oauth2.link.slice(-1) == "/")
            newsettings.api.client.oauth2.link = newsettings.api.client.oauth2.link.slice(0, -1);

        if (newsettings.api.client.oauth2.callbackpath.slice(0, 1) !== "/")
            newsettings.api.client.oauth2.callbackpath = "/" + newsettings.api.client.oauth2.callbackpath;

        if (newsettings.pterodactyl.domain.slice(-1) == "/")
            newsettings.pterodactyl.domain = newsettings.pterodactyl.domain.slice(0, -1);
        
        let packagename = await db.get("package-" + req.params.id);
        let package = newsettings.api.client.packages.list[packagename ? packagename : newsettings.api.client.packages.default];
        if (!package) package = default_package;

        package["name"] = packagename;

        let pterodactylid = await db.get("users-" + req.params.id);
        let userinforeq = await fetch(
            newsettings.pterodactyl.domain + "/api/application/users/" + pterodactylid + "?include=servers",
            {
            method: "GET",
            headers: { 'Content-Type': 'application/json', "Authorization": `Bearer ${newsettings.pterodactyl.key}` }
            }
        );
        if (await userinforeq.statusText == "Not Found") {
            console.log("[WEBSITE] An error has occured while attempting to get a user's information");
            console.log("- Discord ID: " + req.params.id);
            console.log("- Pterodactyl Panel ID: " + pterodactylid);
            return res.send({ status: "could not find user on panel" });
        }
        let userinfo = await userinforeq.json();

        return res.json({
            status: "success",
            package,
            extra: await db.get("extra-" + req.params.id)
                ? await db.get("extra-" + req.params.id)
                : default_package,
            userinfo,
            coins: newsettings.api.client.coins.enabled ? (await db.get("coins-" + req.params.id) ? await db.get("coins-" + req.params.id) : 0) : null
        });
    });
    
    app.post('/api/createserver', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;
        
        if (typeof req.body !== 'object') return res.json({ status: 'body must be an object' });
        if (Array.isArray(req.body)) return res.json({ status: 'body cannot be an array' });
        
        if (!settings.api.client.allow.server.create) return res.json({ status: 'server creation is disabled' });
        
        if (!req.body.userid) return res.json({ status: 'missing userid' });
        if (!req.body.name) return res.json({ status: 'missing server name' });
        if (!req.body.ram) return res.json({ status: 'missing server ram' });
        if (!req.body.disk) return res.json({ status: 'missing server disk' });
        if (!req.body.cpu) return res.json({ status: 'missing server cpu' });
        if (!req.body.egg) return res.json({ status: 'missing server egg' });
        if (!req.body.location) return res.json({ status: 'missing server location' });
        
        let { userid, name, ram, disk, cpu, egg, location } = req.body;
        const user = await db.get(`users-${userid}`);
        if (!user) return res.json({ status: 'invalid userid' });
        
        ram = parseFloat(ram);
        disk = parseFloat(disk);
        cpu = parseFloat(cpu);
        if (isNaN(ram) || isNaN(disk) || isNaN(cpu)) return res.json({ status: 'ram, disk, or cpu is not a number' });
        
        const extra = await db.get(`extra-${userid}`) || default_package;
        const packagename = await db.get(`package-${userid}`);
        const package = settings.api.client.packages.list[packagename || settings.api.client.packages.default];
        
        let newram = 0, newdisk = 0, newcpu = 0;
        let newsevers = user.userinfo.attributes.relationships.servers.data.length;
        if (newservers >= package.servers + extra.servers) return res.json({ status: 'user has reached the max servers limit' });
        
        const fetchedlocation = Object.entries(settings.api.client.locations)
            .filter(name => name[0] === location);
        if (fetchedlocation.length !== 1) return res.json({ status: 'invalid server location' });
        
        user.userinfo.attributes.relationships.servers.data.forEach(a => {
            newram += a.attributes.limits.memory;
            newdisk += a.attributes.limits.disk;
            mewcpu += a.attributes.limits.cpu;
        });
        
        const requiredpackage = fetchedlocation[0][1].package;
        if (
            requiredpackage &&
            !requiredpackage.includes((packagename || settings.api.client.packages.default))
        ) return res.json({ status: 'location for premium only' });
        
        const egginfo = settings.api.client.eggs[egg];
        if (!egginfo) return res.json({ status: 'invalid egg' });
        
        if (newram + ram > package.ram + extra.ram) return res.json({ status: `exceeded ram amount by ${(package.ram + extra.ram) - newram}` });
        if (newdisk + disk > package.disk + extra.disk) return res.json({ status: `exceeded disk amount by ${(package.disk + extra.disk) - newdisk}` });
        if (newcpu + cpu > package.cpu + extra.cpu) return res.json({ status: `exceeded cpu amount by ${(package.cpu + extra.cpu) - newcpu}` });
        if (egginfo.maximum) {
            if (ram > egginfo.maximum.ram) return res.json({ status: 'exceeded maximum ram for egg' });
            if (disk > egginfo.maximum.disk) return res.json({ status: 'exceeded maximum disk for egg' });
            if (cpu > egginfo.maximum.cpu) return res.json({ status: 'exceeded maximum cpu for egg' });
        }
        if (egginfo.minimum) {
            if (ram < egginfo.minimum.ram) return res.json({ status: 'too little ram for egg' });
            if (disk < egginfo.minimum.disk) return res.json({ status: 'too little disk for egg' });
            if (cpu < egginfo.minimum.cpu) return res.json({ status: 'too little cpu for egg' });
        }
        
        let specs = egginfo.info;
        specs.user = user;
        if (!specs.limits) specs.limits = { swaps: 0, io: 500, backups: 0 };
        specs.name = name;
        specs.limits.memory = ram;
        specs.limits.disk = disk;
        specs.limits.cpu = cpu;
        if (!specs.deploy) specs.deploy = { locations: [location], dedicated_ip: false, port_range: [] };
        
        const serverinfo = await fetch(
            `${settings.pterodactyl.domain}/api/application/servers`, {
                method: 'POST',
                body: JSON.stringify(specs),
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        const json = await serverinfo.json();
        if (!serverinfo.ok) {
            console.log(json);
            return res.json({ status: 'error on create', code: serverinfo.statusCode });
        }
        return res.json({ status: 'success', data: json });
    }

    app.post("/api/setcoins", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });

        let id = req.body.id;
        let coins = req.body.coins;

        if (typeof id !== "string") return res.json({status: "id must be a string"});
        if (typeof coins !== 'number') return res.json({ status: 'coins must be a number' });
        if (!(await db.get("users-" + id))) return res.json({ status: "invalid id" });
        if (coins < 0 || coins > 999999999999999) return res.json({ status: "too small or big coins" });

        if (coins == 0) {
        await db.delete("coins-" + id)
        } else {
        await db.set("coins-" + id, coins);
        }

        return res.json({ status: "success" });
    });

    app.post("/api/addcoins", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });

        let id = req.body.id;
        let coins = req.body.coins;

        if (typeof id !== "string") return res.json({ status: "id must be a string" });
        if (typeof coins !== "number") return res.json({ status: "coins must be number" });
        if (!(await db.get("users-" + id))) return res.json({ status: "invalid id" });

        let currentcoins = await db.get("coins-" + id) || 0;
        coins += currentcoins;
        if (coins < 0 || coins > 999999999999999) return res.json({ status: "too small or big coins" });

        if (coins == 0) {
        await db.delete("coins-" + id);
        } else {
        await db.set("coins-" + id, coins);
        }

        return res.json({ status: "success" });
    });

    app.delete("/api/removeaccount/:id", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (!req.params.id) return res.json({ status: 'missing id' });
        let id = req.params.id;
        if (typeof id !== "string") return res.json({ status: "id must be a string" });

        if (!(await db.get("users-" + id))) return res.json({status: "invalid id"});
        let discordid = id;
        let pteroid = await db.get("users-" + discordid);

        // Remove IP.
        let selected_ip = await db.get("ip-" + discordid);
        if (selected_ip) {
            let allips = await db.get("ips") || [];
            allips = allips.filter(ip => ip !== selected_ip);

            if (allips.length == 0) {
                await db.delete("ips");
            } else {
                await db.set("ips", allips);
            }

            await db.delete("ip-" + discordid);
        }

        // Remove user.
        let userids = await db.get("users") || [];
        userids = userids.filter(user => user !== pteroid);

        if (userids.length == 0) {
            await db.delete("users");
        } else {
            await db.set("users", userids);
        }

        await db.delete("users-" + discordid);

        // Remove coins/resources.
        await db.delete("coins-" + discordid);
        await db.delete("extra-" + discordid);
        await db.delete("package-" + discordid);

        return res.json({ status: "success" });
    });

    app.patch("/api/setplan", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        if (typeof req.body.id !== "string") return res.json({ status: "missing id" });
        if (!(await db.get("users-" + req.body.id))) return res.json({ status: "invalid id" });

        if (typeof req.body.package !== "string") {
            await db.delete("package-" + req.body.id);
            adminjs.suspend(req.body.id);
            return res.json({status: "success"});
        } else {
            let newsettings = JSON.parse(fs.readFileSync("./settings.json").toString());
            if (!newsettings.api.client.packages.list[req.body.package]) return res.json({ status: "invalid package" });
            await db.set("package-" + req.body.id, req.body.package);
            adminjs.suspend(req.body.id);
            return res.json({ status: "success" });
        }
    });

    app.patch("/api/setresources", async (req, res) => {
        let settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        if (typeof req.body.id !== "string") return res.json({ status: "missing id" });
        if (!(await db.get("users-" + req.body.id))) res.json({ status: "invalid id" });

        if (typeof req.body.ram == "number" || typeof req.body.disk == "number" || typeof req.body.cpu == "number" || typeof req.body.servers == "number") {
            let ram = req.body.ram;
            let disk = req.body.disk;
            let cpu = req.body.cpu;
            let servers = req.body.servers;
            let currentextra = await db.get("extra-" + req.body.id);
            let extra;

            if (typeof currentextra == "object") {
                extra = currentextra;
            } else {
                extra = default_package;
            }

            if (typeof ram == "number") {
                if (ram < 0 || ram > 999999999999999) return res.json({ status: "exceeded ram size" });
                extra.ram = ram;
            }
            if (typeof disk == "number") {
                if (disk < 0 || disk > 999999999999999) return res.json({ status: "exceeded disk size" });
                extra.disk = disk;
            }
            if (typeof cpu == "number") {
                if (cpu < 0 || cpu > 999999999999999) return res.json({ status: "exceeded cpu size" });
                extra.cpu = cpu;
            }
            if (typeof servers == "number") {
                if (servers < 0 || servers > 999999999999999) return res.json({ status: "exceeded server size" });
                extra.servers = servers;
            }
            if (extra.ram == 0 && extra.disk == 0 && extra.cpu == 0 && extra.servers == 0) {
                await db.delete("extra-" + req.body.id);
            } else {
                await db.set("extra-" + req.body.id, extra);
            }

            adminjs.suspend(req.body.id);
            return res.json({ status: "success" });
        } else {
            return res.json({ status: "missing variables" });
        }
    });
    
    app.get('/api/coupons', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;
        
        if (req.query.code) {
            const { code } = req.query;
            if (!/^[a-z0-9]+$/i.test(code)) return res.json({ status: 'invalid coupon code' });
            if (!(await db.get(`coupon-${code}`))) return res.json({ status: 'invalid coupon code' });
            const coupon = await db.get(`coupon-${code}`);
            return res.json({ status: 'success', coupon });
        }
        
        const coupons = await db.get('coupon');
        return res.json({ status: 'success', coupons });
    }

    app.post("/api/createcoupon", async (req, res) => {
        let settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        let code = typeof req.body.code == "string" ? req.body.code.slice(0, 200) : Math.random().toString(36).substring(2, 15);
        if (!code.match(/^[a-z0-9]+$/i)) return res.json({ status: "illegal characters" });

        let coins = typeof req.body.coins == "number" ? req.body.coins : 0;
        let ram = typeof req.body.ram == "number" ? req.body.ram : 0;
        let disk = typeof req.body.disk == "number" ? req.body.disk : 0;
        let cpu = typeof req.body.cpu == "number" ? req.body.cpu : 0;
        let servers = typeof req.body.servers == "number" ? req.body.servers : 0;

        if (coins < 0) return res.json({ status: "coins is less than 0" });
        if (ram < 0) return res.json({ status: "ram is less than 0" });
        if (disk < 0) return res.json({ status: "disk is less than 0" });
        if (cpu < 0) return res.json({ status: "cpu is less than 0" });
        if (servers < 0) return res.json({ status: "servers is less than 0" });

        if (!coins && !ram && !disk && !cpu && !servers) return res.json({ status: "cannot create empty coupon" });

        await db.set("coupon-" + code, {
            coins: coins,
            ram: ram,
            disk: disk,
            cpu: cpu,
            servers: servers
        });

        return res.json({ status: "success", code });
    });

    app.delete("/api/revokecoupon/:code", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (!req.params.code) return res.json({ status: 'missing code'});

        let code = req.params.code;
        if (!code) return res.json({ status: "missing code" });
        if (!code.match(/^[a-z0-9]+$/i)) return res.json({ status: "invalid code" });
        if (!(await db.get("coupon-" + code))) return res.json({ status: "invalid code" });

        await db.delete("coupon-" + code);

        return res.json({ status: "success" })
    });

    async function check(req, res) {
        let settings = JSON.parse(fs.readFileSync("./settings.json").toString());
        if (settings.api.client.api.enabled) {
            let auth = req.headers['Authorization'];
            if (auth) {
                if (auth == "Bearer " + settings.api.client.api.code) return settings;
            };
        }
        let theme = indexjs.get(req);
        ejs.renderFile(
            `./themes/${theme.name}/${theme.settings.notfound}`, 
            await eval(indexjs.renderdataeval),
            null,
            function (err, str) {
                delete req.session.newaccount;
                if (err) {
                    console.log(`[WEBSITE] An error has occured on path ${req._parsedUrl.pathname}:`);
                    console.log(err);
                    return res.json("An error has occured while attempting to load this page. Please contact an administrator to fix this.");
                };
                res.status(404).json(str);
            }
        );
        return null;
    }
};
