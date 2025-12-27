# MeshCore Packet Knife

A web-based tool for decoding MeshCore mesh networking packets, with GPU-accelerated brute force key cracking for hashtag rooms.

## Use it here: https://jkingsman.github.io/meshcore-packet-knife/

### Important note: Nothing is broken or insecure in the parts of MeshCore that are meant to be secure. DMs are private. Private channels are private. Hashtag rooms (especially those with short names) are not, and have never been, private. MeshCore is secure; nothing has changed.

## Credit

All meaningful work here is built on top of [meshcore-decoder](https://github.com/michaelhart/meshcore-decoder). Michael has put a TON of legwork into this community, and his work is outstanding.

This wrapper, including the WebGPU SHA256/HMAC shader, is sufficiently uninteresting that an LLM produced it in its entirety with minimal human oversight. I, as "author," claim basically zero credit.

Let me restate that: *this is a vibe-coded tool. I make no warranty of fitness for this code.*

## Usage

### Quick Start

```bash
git clone https://github.com/jkingsman/meshcore-packet-knife
cd meshcore-packet-knife
npm install
npm run build
npm run serve
```

Then open http://localhost:3000/dist in your browser. You can use the rich packet analysis interface, or the more advanced bulk cracker (link under title on the page). If you want to use the bulk cracker to crack live packets from your radio, use the serial cracker link on the bulk page.

### Development

```bash
npm run watch    # Rebuild on file changes
npm test         # Run tests
npm run test:watch
```

## FAQ

## **How does this work?**

The packet visualization is just a wrapper around [meshcore-decoder](https://github.com/michaelhart/meshcore-decoder). Cracking is probably the part you're interested in, though:

Hashtag rooms (at least in the app I use for Android) have restrictions: alphanum, lowercase, with hyphens, and no leading/trailing/double hypens, with max length of 30. The key for hashtag rooms is the first 16 bytes of the SHA256 of `"#" + roomName`. That's a darn small keyspace, and we have the `channelHash`, which gives us the SHA256 of the valid key; the `cipherMac` gives us further confirmation of a correct key.

`gpu-bruteforce.ts` contains a WebGPU shader for doing SHA256 hashes and manipulating them in the GPU; this is orders of magnitude faster than on CPU. The rest is just logic and window-dressing around the testing process.

Pigeonhole principle helpfully tells us that with a two byte MAC, we're gonna get a LOT of collisions as we brute force. So, to increase the likelihood of a good key retrieval, I added options to only count keys as valid if they 1) give a recent timestamp and 2) can decode the message as valid UTF-8. There's no reason people can't send wildly wrong timestampt or binary data in a message, but this is a proof of concept (and as the search space increases, the feasibility of this attack falls to zero, so *make your search space massive by using public/hashtag channels for public things and private channels or direct messages for private things -- MeshCore has great crypto; use it!*)

## **Why does this exist?**

Hashtag rooms are insecure by design (no key to remember; just the room name, and room names have limitations in most interfaces). Part of building a solid platform is making attacks concrete rather than theoretical via red-teaming. I'm an SRE with a security focus, and I also kinda wanted to see if this would actually work (it does).

MeshCore is excellent and I love it; I've set up multiple repeaters and MQTT ingest for packet analyses over the last few weeks. This tool is intended to make an on-paper limitation tangible.

*Critically, MeshCore has excellent, modern crypto with good key derivation available via other features in the app (i.e. everywhere but public/hashtag rooms), so if anything, this is a nudge to use the proper [private] channels when you want things private.*

## **Does this mean MeshCore is insecure?**

# No. MeshCore is secure.

Hashtag rooms have keys derived from their names, which makes them easy to share and join. Private rooms and direct messages use proper randomly-vectored key derivation and do not suffer from such a restricted keyspace. *Nothing has been hacked or broken.* This tool simply demonstrates the practical reality of "anyone can join a hashtag room."

## **How fast is the brute force?**

Depends on your GPU. All hashtag keys of length less than seven are exhaustively bruteforced in about 90s on my 2023 Macbook Air.

## **Can this crack private rooms or direct messages?**

No, statistically speaking. Those use keys that aren't derived from short, predictable room names. The brute force approach here only works because hashtag rooms use `SHA256("#roomname")` as the key, and room names are short strings from a limited character set. Collisions are technically possible, but practically impossible. Thus, if anything, this project should nudge you towards using private messages and channels for anything you don't want the world to read!

## **My lord, is this... legal?**

ᴵ ʷᶦˡˡ ᵐᵃᵏᵉ ᶦᵗ ˡᵉᵍᵃˡ

Just kidding.

This is a security research and educational tool. This tool alone does not break laws. Hashtag rooms are explicitly labelled as insecure/public in most clients, so it's probably pretty hard to break any assumptions, let alone laws, with this tool. If this software outrages you, you're probably using hashtag rooms for things you shouldn't be. You may be noticing a theme here:

*Hashtag rooms should be considered world-readable, by design. MeshCore provides fantastic, modern cryptography -- use it!!*

### **How does the WebGPU stuff work?**

No idea. I had an LLM write it for me, and I minimally validated it.

## License and Licenses

This code is licensed MIT (c) 2025 Jack Kingsman <jack@jackkingsman.me>, but was broadly composed by LLM.

This codebase uses [meshcore-decoder](https://github.com/michaelhart/meshcore-decoder/tree/main), Copyright (c) 2025 Michael Hart michaelhart@michaelhart.me (https://github.com/michaelhart). His code is the core of this tool; he is the giant upon whose shoulders I stood to do silly things with WebGPU.


