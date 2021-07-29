const indexjs = require("../index.js");
const adminjs = require("./admin.js");
const fs = require("fs");
const ejs = require("ejs");
const fetch = require('node-fetch');
const default_package = { ram: 0, disk: 0, cpu: 0, servers: 0 };
const ERR_503 = { status: 'dashactyl api is not enabled' };

module.exports.load = async function(app, db) {
    app.get("/api", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);
        res.json({ status: true });
    });

    app.get('/api/users/:id', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);
        if (!req.params.id) return res.json({ status: "missing id" });

        const userid = await db.get(`users-${req.params.id}`);
        if (!userid) return res.json({ status: "invalid user id" });

        let packagename = await db.get(`package-${userid}`);
        let package = settings.api.client.packages.list[packagename || settings.api.client.packages.default];
        if (!package) package = default_package;
        package["name"] = packagename;

        const data = await fetch(
            `${settings.pterodactyl.domain}/api/application/users${userid}?include=servers`, {
                method: "GET",
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        if (!data.ok) return res.json({ status: 'user not found' });
        const userinfo = await data.json();

        return res.json({
            status: "success",
            package,
            extra: await db.get("extra-" + req.params.id) ?? default_package,
            userinfo,
            coins: settings.api.client.coins.enabled ? (await db.get("coins-" + req.params.id) ?? 0) : null
        });
    });

    app.post('/api/users', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (typeof req.body !== 'object') return res.json({ status: 'body must be an object' });
        if (Array.isArray(req.body)) return res.json({ status: 'body cannot be an array' });

        if (!settings.api.client.allow.newusers) return res.json({ status: 'user account creation is disabled' });

        if (!req.body.username) return res.json({ status: 'missing username' });
        if (!req.body.email) return res.json({ status: 'missing email' });
        if (!req.body.first_name) return res.json({ status: 'missing firstname' });
        if (!req.body.last_name) return res.json({ status: 'missing lastname' });

        const { username, email, first_name, last_name } = req.body;
        if (await db.get(`users-${username}`)) return res.json({ status: 'account already exists' });

        let password = req.body?.password;
        if (!password) password = make(settings.api.client.api.passwordgenerator.length ?? 8);
        const payload = {
            username,
            email,
            first_name,
            last_name: last_name.startsWith('#') ? last_name : '#'+last_name,
            password
        };

        const data = await fetch(
            `${settings.pterodactyl.domain}/api/application/users`, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        if (!data.ok) return res.json({ status: 'error on account create', code: data.status });
        return res.json({ status: 'success', data: await data.json() });
    });

    app.patch('/api/users/:id/plan', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (!req.params.id) return res.json({ status: 'missing user id parameter' });
        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        if (!(await db.get("users-" + req.params.id))) return res.json({ status: 'invalid user id' });

        if (typeof req.body.package !== "string") {
            await db.delete("package-" + req.params.id);
            adminjs.suspend(req.params.id);
            return res.json({ status: "success" });
        } else {
            if (!settings.api.client.packages.list[req.body.package]) return res.json({ status: "invalid package" });
            await db.set("package-" + req.params.id, req.body.package);
            adminjs.suspend(req.params.id);
            return res.json({ status: "success" });
        }
    });

    app.patch('/api/users/:id/resources', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (!req.params.id) return res.json({ status: 'missing user id parameter' });
        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        if (!(await db.get("users-" + req.params.id))) res.json({ status: 'invalid user id' });

        if (
            typeof req.body.ram == "number"
            || typeof req.body.disk == "number"
            || typeof req.body.cpu == "number"
            || typeof req.body.servers == "number"
        ) {
            let ram = req.body.ram;
            let disk = req.body.disk;
            let cpu = req.body.cpu;
            let servers = req.body.servers;
            let currentextra = await db.get("extra-" + req.params.id);
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
                await db.delete("extra-" + req.params.id);
            } else {
                await db.set("extra-" + req.params.id, extra);
            }

            adminjs.suspend(req.params.id);
            return res.json({ status: "success" });
        } else {
            return res.json({ status: "missing variables" });
        }
    });

    app.delete('/api/users/:id', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (!req.params.id) return res.json({ status: 'missing id' });
        const { id } = req.params;
        if (typeof id !== "string") return res.json({ status: "id must be a string" });

        if (!(await db.get(`users-${id}`))) return res.json({ status: "invalid user id" });
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

    app.post('/api/users/:id/servers', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (!req.params.id) return res.json({ status: 'missing user id parameter' });
        if (typeof req.body !== 'object') return res.json({ status: 'body must be an object' });
        if (Array.isArray(req.body)) return res.json({ status: 'body cannot be an array' });

        if (!settings.api.client.allow.server.create) return res.json({ status: 'server creation is disabled' });

        if (!req.body.name) return res.json({ status: 'missing server name' });
        if (!req.body.ram) return res.json({ status: 'missing server ram' });
        if (!req.body.disk) return res.json({ status: 'missing server disk' });
        if (!req.body.cpu) return res.json({ status: 'missing server cpu' });
        if (!req.body.egg) return res.json({ status: 'missing server egg' });
        if (!req.body.location) return res.json({ status: 'missing server location' });

        const { id } = req.params;
        let { name, ram, disk, cpu, egg, location } = req.body;
        let user = await db.get(`users-${id}`);
        if (!user) return res.json({ status: 'invalid user id' });
        const userdata = await fetch(
            `${settings.pterodactyl.domain}/api/application/users${user}?include=servers`, {
                method: "GET",
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        if (!userdata.ok) return res.json({ status: 'unable to fetch user data' });
        user = await userdata.json();

        ram = parseFloat(ram);
        disk = parseFloat(disk);
        cpu = parseFloat(cpu);
        if (isNaN(ram) || isNaN(disk) || isNaN(cpu)) return res.json({ status: 'ram, disk, or cpu is not a number' });

        const extra = await db.get(`extra-${id}`) || default_package;
        const packagename = await db.get(`package-${id}`);
        const package = settings.api.client.packages.list[packagename || settings.api.client.packages.default];

        let newram = 0, newdisk = 0, newcpu = 0;
        let newservers = user.userinfo.attributes.relationships.servers.data.length;
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

        const data = await fetch(
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
        if (!serverinfo.ok) return res.json({ status: 'error on server create', code: data.status });
        return res.json({ status: 'success', data: await data.json() });
    });

    app.delete('/api/users/:userid/servers/:serverid', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (!req.params.userid) return res.json({ status: 'missing user id' });
        if (!req.params.serverid) return res.json({ status: 'missing server id' });
        if (typeof req.params.userid !== 'string') return res.json({ status: 'user id must be a string' });
        if (typeof req.params.serverid !== 'string') return res.json({ status: 'server id must be a string' });
        if (!settings.api.client.allow.server.delete) return res.json({ status: 'server deletion is disabled' });

        const { userid, serverid } = req.params;
        let user = await db.get(`users-${userid}`);
        if (!user) return res.json({ status: 'invalid user id' });
        const userdata = await fetch(
            `${settings.pterodactyl.domain}/api/application/users${user}?include=servers`, {
                method: "GET",
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        if (!userdata.ok) return res.json({ status: 'unable to fetch user data' });
        user = await userdata.json();
        const servers = user.userinfo.relationships.servers.data;
        if (!servers.some(s => s.attributes.id === serverid)) return res.json({ status: 'server with that id not found' });

        const result = await fetch(
            `${settings.pterodactyl.domain}/api/application/servers/${serverid}`, {
                method: 'DELETE',
                headers:{
                    'Authorization': `Bearer ${settings.pterodactyl.key}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        if (!result.ok) return res.json({ status: 'error on server delete', code: result.status });
        return res.json({ status: 'success' });
    });

    app.post("/api/setcoins", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });
        if (typeof req.body.id !== "string") return res.json({status: "id must be a string"});
        if (typeof req.body.coins !== 'number') return res.json({ status: 'coins must be a number' });

        const { id, coins } = req.body;
        if (!(await db.get(`users-${id}`))) return res.json({ status: "invalid id" });
        if (coins < 0 || coins > 999999999999999) return res.json({ status: "too small or big coins" });

        if (coins === 0) {
            await db.delete(`coins-${id}`)
        } else {
            await db.set(`coins-${id}`, coins);
        }

        return res.json({ status: "success" });
    });

    app.patch("/api/addcoins", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return;

        if (typeof req.body !== "object") return res.json({ status: "body must be an object" });
        if (Array.isArray(req.body)) return res.json({ status: "body cannot be an array" });

        let id = req.body.id;
        let coins = req.body.coins;

        if (typeof id !== "string") return res.json({ status: "id must be a string" });
        if (typeof coins !== "number") return res.json({ status: "coins must be number" });
        if (!(await db.get("users-" + id))) return res.json({ status: "invalid id" });

        let current = await db.get("coins-" + id) || 0;
        coins += current;
        if (coins < 0 || coins > 999999999999999) return res.json({ status: "too small or big coins" });

        if (coins === 0) {
            await db.delete("coins-" + id);
        } else {
            await db.set("coins-" + id, coins);
        }

        return res.json({ status: "success" });
    });

    app.get('/api/coupons', async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (req.query.code) {
            const { code } = req.query;
            if (!/^[a-z0-9]+$/i.test(code)) return res.json({ status: 'invalid coupon code' });
            if (!(await db.get(`coupon-${code}`))) return res.json({ status: 'invalid coupon code' });
            const coupon = await db.get(`coupon-${code}`);
            return res.json({ status: 'success', coupon });
        }

        const coupons = await db.get('coupon');
        if (!coupons) return res.json({ status: 'no coupons found' });
        return res.json({ status: 'success', coupons });
    });

    app.post("/api/coupons", async (req, res) => {
        let settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

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

        await db.set(`coupon-${code}`, {
            coins,
            ram,
            disk,
            cpu,
            servers
        });

        return res.json({ status: "success", code });
    });

    app.delete("/api/coupons/:code", async (req, res) => {
        const settings = await check(req, res);
        if (!settings) return res.status(503).json(ERR_503);

        if (!req.params.code) return res.json({ status: 'missing code' });

        const { code } = req.params;
        if (!code.match(/^[a-z0-9]+$/i)) return res.json({ status: "invalid code" });
        if (!(await db.get(`coupon-${code}`))) return res.json({ status: "invalid code" });

        await db.delete(`coupon-${code}`);
        return res.json({ status: "success" });
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

    function make(length) {
        let result = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
};
