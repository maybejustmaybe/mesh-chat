#!/usr/local/bin/node

'use strict'

const argv = require("minimist")(process.argv.slice(1))

const Buffer = require("buffer").Buffer
const fs = require('fs')
const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
});
const EventEmitter = require('events').EventEmitter

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

const KNOWN_PEERS = [
    // TODO : replace this with well known peers on the mesh network!
    "/ip4/0.0.0.0/tcp/4001/ipfs/QmcB8sBNuwsj9XYNW2Q5xSZo4VLQ7d5i2PX6xgCu6AmYZP",
]

const PROMPT = "> "

const DEFAULT_NAME = "nobody"
// NOTE that this has to be 24 chars
const DEFAULT_PASSWORD = "cancel-cretinous-cable-cartels"
const DEFAULT_SWARM_KEY_PATH = "./nycmesh_swarm.key"
const DEFAULT_SWARM_PORT = "4123"
const DEFAULT_TOPIC = "main"


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
    constructor(node, name) {
        super()

        this._node = node
        this._name = name

        this._topic = null
    }

    async bootstrap () {
        // TODO : use a better algo here (e.g. happy eyeballs) or at least shuffle `KNOWN_PEERS`
        for (var addr of KNOWN_PEERS) {
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
            topic, (raw) => {
                const data = JSON.parse(raw.data.toString())
                if (data.type == "joined") {
                    this.emit("user:joined", data.name)
                } else if (data.type == "message") {
                    this.emit("user:message", data.name, data.payload)
                } else {
                    this.emit("error", `encountered invalid message: ${data.type}`)
                }
            },
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
}


/* MAIN */

async function main() {
    if (argv["repo-path"] === undefined) {
        console.log("FATAL: must provide --repo-path")
        process.exit()
    } else {
        console.log(`INFO: using IPFS repo ${argv["repo-path"]}`)
    }

    const name = argv["name"] === undefined ? DEFAULT_NAME : argv["name"]
    const topic = argv["topic"] === undefined ? DEFAULT_TOPIC : argv["topic"]

    const config = createConfig(argv["repo-path"], argv["swarm-port"], argv["password"], argv["swarm-key-path"])
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
    var peerCount = null
    setInterval(async () => {
        const peers = await node.swarm.peers()
        if (peers.length != peerCount) {
            writeToConsole(`INFO: Connected to ${peers.length} peers`)
            peerCount = peers.length
        }
    }, 5*1000)

    readline.setPrompt("> ")

    const writeToConsole = (line) => {
        console.log("\r".repeat(PROMPT.length) + line)
        readline.prompt()
    }

    client.on("user:joined", (name) => writetoconsole(`${name} joined!`))
    client.on("user:message", (name, payload) => writeToConsole(`${name}> ${payload}`))
    client.on("error", (err) => `WARNING: encountered an error: ${err}`)

    writeToConsole(`INFO: joining '${topic}' topic...`)

    await client.subscribe(topic)

    // TODO : we might want to integrate this later
    // {},
    // async () => {
    //     writeToConsole(`${name} joined!`)
    //     // TODO : this message may be sent before we are connected to all of our peers on the topic
    //     // For now, we sleep for a few seconds in the hope that we will have connected
    //     // to all of our peers
    //     setTimeout(
    //         () => {
    //             node.pubsub.publish(
    //                 topic,
    //                 Buffer.from(JSON.stringify({name: name, type: "joined"}))
    //             )
    //         },
    //         3 * 1000
    //     )
    // }

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