## Overview

A decentralized messaging service built on top of IPFS

Why IPFS? IPFS is decentralized/distributed protocol that enables the service to run without a central point of failure. This messaging service should be able to work even if our network gets partitioned (e.g. a supernode serving an entire neighborhood goes down).

Why a private IPFS network/swarm? By using a "swarm key" we can create an IPFS sub-network only for nodes on NYCMesh. Since IPFS is still in alpha, there are features that are too slow to use on the global network (e.g. the DHT). Many of these performance issues can be avoided buy running IPFS on a smaller network.

Why bootstrap nodes? In order to join to the network a new client needs to connect to an initial set of peers. This project currently uses "bootstrap" nodes, which are just regular IPFS nodes, that have well known IPs on the mesh. Initially, a client connects to a bootstrap node which then tells it about other IPFS nodes on the network. The addresses of these nodes are distributed with the source code.

## Install

Install `node` and then `npm install`

## How To

You can use the messaging client on the command line by invoking `./chat.js`.

Required Command Line Arguments:
- `--repo-path` a path to the IPFS repo to use (if the repo is empty a new IPFS repo will be initialized)
- `--name` your display name

There is also a provided example config for running a bootstrap node.

Please post questions to the #mesh-services NYCMesh slack channel: https://app.slack.com/client/T02MB96L1/C06H99CGY

## Status

This project is still in very early stages. Our main goal right now is to find out whether or not IPFS is a good fit for building decentralized, reliable, and secure services.
