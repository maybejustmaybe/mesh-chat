#!/usr/local/bin/node

'use strict'

const Buffer = require('buffer').Buffer
const EventEmitter = require('events').EventEmitter
const fs = require('fs')
const os = require("os")
const path = require('path')

const IPFS = require("ipfs")
const Protector = require('libp2p/src/pnet')
const Room = require('ipfs-pubsub-room')
const argv = require('minimist')(process.argv.slice(1))
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
});


/* CONSTS */

const MEMBER_HEARTBEAT_INTERVAL = 1 * 1000

const KNOWN_PEERS = [
    // TODO : replace this with well known peers on the mesh network!
    // "/ip4/10.100.8.56/tcp/4001/ipfs/QmV7kUaknXbsivZuMZLSKND3KVK9nPD79G48r2GiMUPXft",
    "/ip4/0.0.0.0/tcp/4001/ipfs/QmcB8sBNuwsj9XYNW2Q5xSZo4VLQ7d5i2PX6xgCu6AmYZP",
]

const PROMPT = "> "

const DEFAULT_ROOM = "main"
// NOTE that this has to be >20 chars
const DEFAULT_PASSWORD = "cancel-cretinous-cable-cartels"

const DEFAULT_REPO_PATH = path.resolve(os.homedir(), ".mesh_chat/ipfs_repo")
const DEFAULT_SWARM_KEY_PATH = path.resolve("nycmesh_swarm.key")
const DEFAULT_SWARM_PORT = "4123"


/* HELPERS */

const createConfig = (
    repo_path,
    port = DEFAULT_SWARM_PORT,
    password = DEFAULT_PASSWORD,
    swarm_key_path = DEFAULT_SWARM_KEY_PATH
) => {
    return {
        repo: repo_path,
        pass: password,
        libp2p: {
            modules: {
                connProtector: new Protector(fs.readFileSync(swarm_key_path)),
            },
            config: {
                pubsub: {
                    // NOTE that this disables self-delivery
                    emitSelf: false,
                },
            }
        },
        config: {
            Bootstrap: KNOWN_PEERS,
            Addresses: {
                Swarm: ["/ip4/127.0.0.1/tcp/" + port]
            },
        },
        relay: {
            enabled: true, // enable relay dialer/listener (STOP)
            hop: {
              enabled: true // make this node a relay (HOP)
            },
        },
    }
}


/* CORE */

class Client extends EventEmitter {
    constructor (node, name) {
        super()

        this._node = node
        this._name = name

        this._room = null

        this._cid_to_names = {}

        this._interval_ids = []
    }

    async bootstrap () {
        // TODO : use a better algo here (e.g. happy eyeballs) or at least shuffle `KNOWN_PEERS`
        for (const addr of KNOWN_PEERS) {
            try {
                await this._node.swarm.connect(addr)
                break
            } catch (e) {
                // TODO : many times these connect calls throw an exception, even when we actually end up connecting
                console.log(`WARN: Failed to connect to known peer: ${addr}`)
            }
        }

        return (await this._node.swarm.peers()).length != 0
    }

    async join (room_name) {
        if (this._room == null) {
            this._room = new Room(this._node.libp2p, room_name)
        } else {
            throw new Error("This client is already in a room")
        }

        this._room.on(
            "message",
            (msg) => {
                const data = JSON.parse(msg.data)
                if (data.type == "greeting") {
                    if (!Object.values(this._cid_to_names).includes(data.name)) {
                        this.emit("member:joined", data.name)
                        this._cid_to_names[msg.cid] = data.name
                    }
                } else if (data.type == "message") {
                    this.emit("member:message", data.name, data.payload)
                } else {
                    this.emit("error", `Encountered invalid message: ${data.type}`)
                }
            }
        )

        this._interval_ids.push(
            setInterval(
                () => {
                    this._room.broadcast(
                        JSON.stringify({"type": "greeting", "name": this._name})
                    )
                },
                MEMBER_HEARTBEAT_INTERVAL
            )
        )
    }

    async send (msg) {
        if (this._room == null) {
            throw new Error("This client has not subscribed to a room yet")
        }

        await this._room.broadcast(
            JSON.stringify({name: this._name, type: "message", payload: msg})
        )
    }

    disconnect () {}
}


/* MAIN */

async function main() {
    if (argv["help"] != undefined) {
        console.log(
`A chat client for the mesh!

usage: chat --name <username> [--room <default: ${DEFAULT_ROOM}>] [--password <password>]
                              [--repo-path <default: ${DEFAULT_REPO_PATH}>]
                              [--swarm-port <default: ${DEFAULT_SWARM_PORT}>] 
                              [--swarm-key-path <default: ${DEFAULT_SWARM_KEY_PATH}>]

options:
    --name
        Your display name

    --room (optional)
        The chat room or channel that will be joined

    --password (optional)
        The password to the specified room

    --repo-path (optional)
        The path to the IPFS repo that will be used by the client

    --port (optional)
        The port used by the IPFS swarm

    --swarm-key-path (optional)
        The key for the IPFS swarm we are joining
        
        NOTE that for now we assume that the IPFS swarm is private`
        )
        process.exit(0)
    }

    // XXX : add in a `_` "flag" since the parsed args always have it as a key
    // TODO : use a better interface to minimist
    let name, room, password, repo_path, port, swarm_key_path
    const VALID_FLAGS = new Set(["name", "room", "password", "repo-path", "port", "swarm-key-path", "_"])

    let validation_succeeded = true
    for (const invalid_arg of Object.keys(argv).filter(arg => !VALID_FLAGS.has(arg))) {
        console.log(`ERROR: '--${invalid_arg}' is not a valid flag`)
        validation_succeeded = false
    }

    if (!validation_succeeded) {
        process.exit(1)
    }

    if (argv["name"] == undefined) {
        console.log("ERROR: You mush specify a username on the command line (e.g. '--name foobar')")
        process.exit(1)
    }

    name = argv["name"]

    // NOTE that we expect users to always pass both if they aren't using the default room
    if (argv["room"] == undefined ^ argv["password"] == undefined) {
        console.log("ERROR: '--room' and '--password' must both be or not be specified")
        process.exit(1)
    }

    // TOOD : stop passing the password on the command line
    if (argv["room"] != undefined) {
        room = argv["room"]
        password = argv["password"]
    } else {
        room = DEFAULT_ROOM
        password = DEFAULT_PASSWORD
    }

    if (argv["repo-path"] == undefined) {
        repo_path = DEFAULT_REPO_PATH
    } else {
        repo_path = argv["repo-path"]
    }

    console.log(`INFO: using IPFS repo ${repo_path}`)

    port = argv["port"] == undefined ? DEFAULT_SWARM_PORT : argv["port"]
    swarm_key_path = argv["swarm-key-path"] == undefined ? DEFAULT_SWARM_KEY_PATH : argv["swarm-key-path"]

    const config = createConfig(repo_path, port, password, swarm_key_path)
    const node = await IPFS.create(config)
    const client = new Client(node, name)

    console.log("INF0: Bootstrapping...")

    if (await client.bootstrap()) {
        console.log("INFO: Completed boostrapping")
    } else {
        console.log("FATAL: Failed to connect to any peers, exiting.")
        process.exit()
    }

    // Print periodic updates if our peer count changes
    let peerCount = null
    setInterval(async () => {
        const peers = client._room.getPeers()
        if (peers.length != peerCount) {
            writeToConsole(`INFO: Connected to ${peers.length} peers`)
            peerCount = peers.length
        }
    }, 60*1000)

    readline.setPrompt("> ")

    const writeToConsole = (line) => {
        console.log("\r".repeat(PROMPT.length) + line)
        readline.prompt()
    }

    client.on("member:joined", (name) => writeToConsole(`${name} joined!`))
    client.on("member:left", (name) => writeToConsole(`${name} left!`))
    client.on("member:message", (name, payload) => writeToConsole(`${name}> ${payload}`))
    client.on("error", (err) => `WARNING: encountered an error: ${err}`)

    writeToConsole(`INFO: joining '${room}' room...`)

    await client.join(room)
    writeToConsole(`${name} joined!`)

    readline.on("line", async (line) => {
        await client.send(line)
        readline.prompt()
    })
    readline.prompt()
}


main().catch((err) => {
    console.log(err)
    process.exit()
})