#!/usr/local/bin/node

'use strict'

const argv = require('minimist')(process.argv.slice(1))

const Buffer = require('buffer').Buffer
const EventEmitter = require('events').EventEmitter
const fs = require('fs')
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
});
const os = require("os")
const path = require('path')


const IPFS = require("ipfs")

const Libp2p = require('libp2p')
const MPLEX = require('libp2p-mplex')
const Protector = require('libp2p-pnet')
const SECIO = require('libp2p-secio')
const TCP = require('libp2p-tcp')
const MulticastDNS = require('libp2p-mdns')
const Gossipsub = require('libp2p-gossipsub')


/* CONSTS */

const PEER_DISCOVERY_INTERVAL = 2000
const MEMBER_HEARTBEAT_INTERVAL = 3000
// The amount of without a heartbeat before a member is pronounced dead
const MEMBER_CLEANUP_INTERVAL = MEMBER_HEARTBEAT_INTERVAL * 3
const MEMBER_CLEANUP_POLL_INTERVAL = 200

const KNOWN_PEERS = [
    // TODO : replace this with well known peers on the mesh network!
    "/ip4/10.100.8.56/tcp/4001/ipfs/QmV7kUaknXbsivZuMZLSKND3KVK9nPD79G48r2GiMUPXft",
]

const PROMPT = "> "

const DEFAULT_NAME = "nobody"
const DEFAULT_TOPIC = "main"
// NOTE that this has to be >20 chars
const DEFAULT_PASSWORD = "cancel-cretinous-cable-cartels"

const DEFAULT_REPO_PATH = path.resolve(os.homedir(), ".mesh_chat/ipfs_repo")
const DEFAULT_SWARM_KEY_PATH = path.resolve("nycmesh_swarm.key")
const DEFAULT_SWARM_PORT = "4123"


/* HELPERS */

// Copied and adapted from: github.com/libp2p/js-libp2p/examples/pnet-ipfs/libp2p-bundle.js
const privateLibp2pBundle = (swarmKeyPath) => {
    /**
     * This is the bundle we will use to create our fully customized libp2p bundle.
     *
     * @param {libp2pBundle~options} opts The options to use when generating the libp2p node
     * @returns {Libp2p} Our new libp2p node
     */
    const libp2pBundle = (opts) => {
        // Set convenience variables to clearly showcase some of the useful things that are available
        const peerInfo = opts.peerInfo
        const peerBook = opts.peerBook

        // TODO : do we need to specify further pubsub configuration?
        // TODO : better understand the specified defaults here
        return new Libp2p({
            peerInfo,
            peerBook,
            modules: {
                transport: [TCP], // We're only using the TCP transport for this example
                streamMuxer: [MPLEX], // We're only using mplex muxing
                // Let's make sure to use identifying crypto in our pnet since the protector doesn't
                // care about node identity, and only the presence of private keys
                connEncryption: [SECIO],
                // TODO : verify that this works outside of LAN networks
                // TODO : consider using a DHT instead of mdns
                peerDiscovery: [MulticastDNS],
                connProtector: new Protector(fs.readFileSync(swarmKeyPath)),
                pubsub: Gossipsub,
            },
            config: {
                peerDiscovery: {
                    mdns: {
                        interval: PEER_DISCOVERY_INTERVAL,
                        enabled: true
                    }
                },
                pubsub: {
                    // NOTE that this disables self-delivery
                    emitSelf: false,
                }
            }
        })
    }

    return libp2pBundle
}

const createConfig = (
    repo_path,
    swarm_port = DEFAULT_SWARM_PORT,
    password = DEFAULT_PASSWORD,
    swarm_key_path = DEFAULT_SWARM_KEY_PATH
) => {
    return {
        repo: repo_path,
        pass: password,
        libp2p: privateLibp2pBundle(swarm_key_path),
        config: {
            Bootstrap: [],
            Addresses: {
                Swarm: ["/ip4/127.0.0.1/tcp/" + swarm_port]
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

        this._topic = null
        // TODO : use a something better than timestamps
        this._joined_at = null
        this._topic_members = {}

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

    async subscribe (topic) {
        if (this._topic == null) {
            this._topic = topic
        } else {
            throw new Error("This client is already subscribed to a topic")
        }

        await this._node.pubsub.subscribe(
            this._topic, (raw) => {
                const data = JSON.parse(raw.data.toString())

                if (data.type == "heartbeat") {
                    // NOTE that we only emit a joined event if we think that the peer
                    // joined after us
                    if (
                        !(data.name in this._topic_members) &&
                        this._joined_at < new Date(data.joined_at)
                    ) {
                        this.emit("member:joined", data.name)
                    }

                    this._topic_members[data.name] = new Date()
                } else if (data.type == "message") {
                    this.emit("member:message", data.name, data.payload)
                } else {
                    this.emit("error", `Encountered invalid message: ${data.type}`)
                }
            },
            {},
            async () => {
                this._joined_at = new Date()

                // Set up periodic heartbeats from this peer
                this._interval_ids.push(
                    setInterval(
                        () => {
                            this._node.pubsub.publish(
                                this._topic,
                                Buffer.from(
                                    JSON.stringify(
                                        {name: this._name, type: "heartbeat", joined_at: this._joined_at}
                                    )
                                )
                            )
                        },
                        MEMBER_HEARTBEAT_INTERVAL
                    )
                )

                // Clean up peers that have left
                this._interval_ids.push(
                    setInterval(
                        () => {
                            const cur_time = new Date()
                            for (const [name, last_hb_time] of Object.entries(this._topic_members)) {
                                if (cur_time - last_hb_time >= MEMBER_CLEANUP_INTERVAL) {
                                    this.emit("member:left", name)
                                    delete this._topic_members[name]
                                }
                            }
                        },
                        MEMBER_CLEANUP_POLL_INTERVAL,
                    )
                )
            }
        )
    }

    async send (msg) {
        if (this._topic == null) {
            throw new Error("This client has not subscribed to a topic yet")
        }

        await this._node.pubsub.publish(
            this._topic,
            Buffer.from(JSON.stringify({name: this._name, type: "message", payload: msg}))
        )
    }

    disconnect () {
        for (let id of this._interval_ids) {
            clearInterval(id)
        }
    }
}


/* MAIN */

async function main() {
    if (argv["help"] != undefined) {
        console.log(
`A chat client for the mesh!

usage: chat --name <username> [--topic <default: ${DEFAULT_TOPIC}>] [--password <password>]
                              [--repo-path <default: ${DEFAULT_REPO_PATH}>]
                              [--swarm-port <default: ${DEFAULT_SWARM_PORT}>] 
                              [--swarm-key-path <default: ${DEFAULT_SWARM_KEY_PATH}>]

options:
    --name
        Your display name

    --topic (optional)
        The chat topic or channel that will be joined

    --password (optional)
        The password to the specified topic

    --repo-path (optional)
        The path to the IPFS repo that will be used by the client

    --swarm-port (optional)
        The port used by the IPFS swarm

    --swarm-key-path (optional)
        The key for the IPFS swarm we are joining
        
        NOTE that for now we assume that the IPFS swarm is private`
        )
        process.exit(0)
    }

    let name, topic, password, repo_path, swarm_port, swarm_key_path

    if (argv["name"] == undefined) {
        console.log("ERROR: You mush specify a username on the command line (e.g. '--name foobar')")
        process.exit(1)
    }

    name = argv["name"]

    // NOTE that we expect users to always pass both if they aren't using the default room
    if (argv["topic"] == undefined ^ argv["password"] == undefined) {
        console.log("ERROR: '--topic' and '--password' must both be or not be specified")
        process.exit(1)
    }

    // TOOD : stop passing the password on the command line
    if (argv["topic"] != undefined) {
        topic = argv["topic"]
        password = argv["password"]
    } else {
        topic = DEFAULT_TOPIC
        password = DEFAULT_PASSWORD
    }

    if (argv["repo-path"] == undefined) {
        repo_path = DEFAULT_REPO_PATH
    } else {
        repo_path = argv["repo-path"]
    }

    console.log(`INFO: using IPFS repo ${repo_path}`)

    swarm_port = argv["swarm-port"] == undefined ? DEFAULT_SWARM_PORT : argv["swarm-port"]
    swarm_key_path = argv["swarm-key-path"] == undefined ? DEFAULT_SWARM_KEY_PATH : argv["swarm-key-path"]

    const config = createConfig(repo_path, swarm_port, password, swarm_key_path)
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
        const peers = await node.swarm.peers()
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

    writeToConsole(`INFO: joining '${topic}' topic...`)

    await client.subscribe(topic)
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