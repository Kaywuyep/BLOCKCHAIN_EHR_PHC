'use strict';

// MLLP over TLS, mutual TLS and the source-IP allowlist. Certificates are
// generated with openssl at test time; the test is skipped without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { FhirAdapter } = require('./fhirAdapter');
const { startMllpListener } = require('./hl7AdtListener');
const { adtA01Admit } = require('./hl7AdtListener.fixtures');

const VT = '\x0b';
const FS = '\x1c';
const CR = '\r';
const silent = { log() {}, warn() {} };

function haveOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makePki() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-mllp-tls-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=test-ca');
  for (const name of ['server', 'client']) {
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name === 'server' ? 'localhost' : 'interface-engine'}`);
    fs.writeFileSync(path.join(dir, `${name}.ext`), name === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : 'extendedKeyUsage=clientAuth\n');
    run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`);
  }
  const read = (f) => fs.readFileSync(path.join(dir, f));
  return { dir, ca: read('ca.crt'), serverCert: read('server.crt'), serverKey: read('server.key'), clientCert: read('client.crt'), clientKey: read('client.key') };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function exchange(socket, message) {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes(FS)) {
        socket.end();
        resolve(data);
      }
    });
    socket.on('error', (err) => resolve(`ERROR ${err.code || err.message}`));
    socket.on('close', () => resolve(data || 'CLOSED'));
    socket.write(VT + message + FS + CR);
  });
}

test('MLLP over mutual TLS: a client with a CA-signed certificate is accepted, one without is refused', { skip: !haveOpenssl() }, async () => {
  const pki = makePki();
  const port = await freePort();
  const fhirAdapter = new FhirAdapter();
  const inbound = startMllpListener({
    fhirAdapter,
    hospitalID: 'hospital-a',
    port,
    log: silent,
    tls: { cert: pki.serverCert, key: pki.serverKey, ca: pki.ca },
  });
  await new Promise((r) => inbound.on('listen', r));
  try {
    const good = tls.connect({ port, host: '127.0.0.1', ca: pki.ca, cert: pki.clientCert, key: pki.clientKey, servername: 'localhost' });
    await new Promise((r) => good.once('secureConnect', r));
    assert.match(await exchange(good, adtA01Admit), /MSA\|AA/);

    const noCert = tls.connect({ port, host: '127.0.0.1', ca: pki.ca, servername: 'localhost' });
    const reply = await exchange(noCert, adtA01Admit);
    assert.doesNotMatch(reply, /MSA\|AA/, 'a client without a certificate must not get an ACK');

    const plain = net.connect({ port, host: '127.0.0.1' });
    assert.doesNotMatch(await exchange(plain, adtA01Admit), /MSA/, 'plain TCP must not be accepted on a TLS listener');
  } finally {
    await inbound.close();
    fs.rmSync(pki.dir, { recursive: true, force: true });
  }
});

test('MLLP allowlist: connections from addresses not on the list are dropped before processing', async () => {
  const port = await freePort();
  const fhirAdapter = new FhirAdapter();
  const inbound = startMllpListener({ fhirAdapter, hospitalID: 'hospital-a', port, log: silent, allowedIps: ['10.9.9.9'] });
  await new Promise((r) => inbound.on('listen', r));
  try {
    const socket = net.connect({ port, host: '127.0.0.1' });
    await new Promise((r) => socket.once('connect', r));
    const reply = await exchange(socket, adtA01Admit);
    assert.doesNotMatch(reply, /MSA/);
    assert.equal(fhirAdapter.findLocalPatientRecord('hospital-a', 'LAG-00231'), null);
  } finally {
    await inbound.close();
  }
});
