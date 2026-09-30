import assert from 'node:assert/strict';
import { buildRelayPacket, validateRelayPacket } from './protocol.js';
const built=await buildRelayPacket({packetKey:'test-12345678',incidentId:'test-incident',sourceDeviceId:'device-1',category:'fire',priority:'critical',locationLabel:'Zone A',locationSource:'manual',latitude:6.2,longitude:6.7});
assert.equal(validateRelayPacket(built.packet).ok,true);
assert.ok(built.bytes<4096);
const expired={...built.packet,e:Date.now()-1}; assert.equal(validateRelayPacket(expired).ok,false);
const hop={...built.packet,h:built.packet.m}; assert.equal(validateRelayPacket(hop).ok,false);
console.log('relay protocol tests: PASS');
