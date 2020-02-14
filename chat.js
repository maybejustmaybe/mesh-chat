#!/usr/local/bin/node

'use strict'

const argv = require("minimist")(process.argv.slice(1))

const Buffer = require("buffer").Buffer
const fs = require('fs')
const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
});

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
    "/ip4/0.0.0.0/tcp/4001/ipfs/QmQ2wa3xxT9oPJqYNP3Ca6KLwGKtNBZyhNCQTMBMZZgp7N",
]

const PROMPT = "> "

const DEFAULT_NAME = "nobody"
const DEFAULT_PASSWORD = "mesh4ever"
const DEFAULT_SWARM_KEY_PATH = "./nycmesh_swarm.key"
const DEFAULT_SWARM_PORT = "4001"
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

    console.log("INF0: Bootstrapping...")

    // TODO : use a better algo here (e.g. happy eyeballs) or at least shuffle `KNOWN_PEERS`
    for (var multihash of KNOWN_PEERS) {
        try {
            await node.swarm.connect(multihash)
            break
        } catch (e) {
            console.log(`WARN: Failed to connect to known peer: ${multihash}`)
        }
    }

    if ((await node.swarm.peers()).length == 0) {
        console.log("FATAL: Failed to connect to any peers, exiting.")
        process.exit()
    } else {
        console.log("INFO: Completed boostrapping")
    }

    readline.setPrompt("> ")

    const writeToConsole = (line) => {
        console.log("\r".repeat(PROMPT.length) + line)
        readline.prompt()
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

    console.log(`Subscribing to '${topic}'...`)
    await node.pubsub.subscribe(topic, (raw) => {
        const data = JSON.parse(raw.data.toString())
        writeToConsole(`${data.name}> ${data.msg}`)
    })

    readline.on("line", (line) => {
        node.pubsub.publish(topic, Buffer.from(JSON.stringify({name: name, msg: line})))
        readline.prompt()
    })
    readline.prompt()
}


main().catch((err) => {
    console.log(err)
    process.exit()
})