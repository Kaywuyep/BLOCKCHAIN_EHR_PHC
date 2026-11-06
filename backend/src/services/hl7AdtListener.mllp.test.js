'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { FhirAdapter } = require('./fhirAdapter');
const { startMllpListener } = require('./hl7AdtListener');
const { adtA01Admit } = require('./hl7AdtListener.fixtures');

const VT = '\x0b'; // MLLP start-of-block
const FS = '\x1c'; // MLLP end-of-block
const CR = '\r';

/** Finds a free TCP port by briefly binding to port 0 and reading back
 *  what the OS assigned -- small race risk, standard practice for tests
 *  that need a real port number ahead of time (node-hl7-server's
 *  `Inbound` doesn't expose its bound port through its public API). */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

/** Sends a raw HL7 message over a real TCP connection, MLLP-framed, and
 *  resolves with whatever bytes come back (the ACK). */
function sendMllp(port, rawMessage) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(VT + rawMessage + FS + CR);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes(FS)) {
        socket.end();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
}

test('startMllpListener accepts a real MLLP-framed TCP connection, ingests the ADT message, and ACKs it', async () => {
  const fhirAdapter = new FhirAdapter();
  const port = await findFreePort();
  const silentLog = { log() {}, warn() {} };

  const inbound = startMllpListener({ fhirAdapter, hospitalID: 'hospital-a', port, log: silentLog });
  await new Promise((resolve) => inbound.on('listen', resolve));

  try {
    const ack = await sendMllp(port, adtA01Admit);
    assert.match(ack, /MSA\|AA/, 'expected an Application Accept ACK');

    const roster = fhirAdapter.findLocalPatientRecord('hospital-a', 'LAG-00231');
    assert.equal(roster.name, 'ADAEZE N OKAFOR');
  } finally {
    inbound.close();
  }
});

test('startMllpListener ACKs with AE (not a crash) when the MLLP-framed payload is unparseable', async () => {
  const fhirAdapter = new FhirAdapter();
  const port = await findFreePort();
  const silentLog = { log() {}, warn() {} };

  const inbound = startMllpListener({ fhirAdapter, hospitalID: 'hospital-a', port, log: silentLog });
  await new Promise((resolve) => inbound.on('listen', resolve));

  try {
    // A syntactically-valid-enough MSH so the transport accepts the frame
    // and hands it to our handler, but with no PID/PV1 at all -- our own
    // validation (not the transport's) is what should reject this one.
    const bareMsh = 'MSH|^~\\&|A|B|C|D|20240101000000||ADT^A01|MSG1|P|2.5\r';
    const ack = await sendMllp(port, bareMsh);
    assert.match(ack, /MSA\|AE/, 'expected an Application Error ACK for a message with no usable PID');
  } finally {
    inbound.close();
  }
});
