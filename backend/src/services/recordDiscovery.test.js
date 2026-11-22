'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { discoverRecordSources, pathsFromScript } = require('./recordDiscovery');

const SCRIPT = `
  N.get("/visits/all/get",{params:{currentPage:e.currentPage,pageLimit:e.itemsPerPage,search:e.search}});
  N.get("/visits/active/get",{params:{currentPage:1}});
  N.get("/visits/prescriptions/".concat(e));
  N.get("/orders/laboratory/prescribed-tests/".concat(e.id));
  N.get("/consultations/histories/get/",{params:{filter:e.filter}});
  N.get("/patients/generate-missing-certificates");
  N.get("/laboratory/today-stats/get");
  N.get("/patients/allergies/".concat(e));
  N.get("/visits/delete/".concat(e));
`;

test('only safe, record-like GET paths are candidates', () => {
  const paths = pathsFromScript(SCRIPT).map((c) => c.path);
  assert.ok(paths.includes('visits/all/get'));
  assert.ok(paths.includes('visits/prescriptions/'));
  assert.ok(!paths.some((p) => /generate|stats|delete/.test(p)));
  const all = pathsFromScript(SCRIPT).find((c) => c.path === 'visits/all/get');
  assert.deepEqual(all.params, ['currentPage', 'pageLimit', 'search']);
});

function fakeHospital() {
  const calls = [];
  const getJson = async (path, vars) => {
    const p = path.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
    calls.push(p);
    if (/generate|delete|stats/.test(p)) throw new Error('UNSAFE PATH CALLED');
    if (p.startsWith('visits/all/get?search=PSSH/1')) return { data: { docs: [{ id: 7, patient_id: 1, department: 'GOPD', date_visit_start: '2026-11-01T10:00:00Z' }] } };
    if (p.startsWith('visits/active/get')) return { data: { docs: [{ id: 99, patient_id: 2 }] } };
    if (p === 'visits/prescriptions/7') {
      return { data: { tests: [{ id: 50, patient_id: 1, test: { name: 'FBC' }, result_status: 'Ready' }], drugs: [{ id: 60, patient_id: 1, drug: { name: 'Amoxicillin' }, frequency: 'TDS' }], services: [{ id: 70, patient_id: 1 }] } };
    }
    if (p === 'orders/laboratory/prescribed-tests/7') return { data: [{ id: 50, patient_id: 1, test: { name: 'FBC' } }] }; // same tests again
    if (p === 'patients/allergies/1') return { data: [{ id: 80, patient_id: 1, name: 'Penicillin' }] };
    if (p.startsWith('consultations/histories')) return { data: { docs: [{ id: 90, patient_id: 2, complaint_note: 'other patient' }] } };
    throw new Error(`404 ${p}`);
  };
  return { calls, getJson };
}

test('discovery finds visits, per-visit and per-patient records for this patient only, without duplicates', async () => {
  const web = http.createServer((req, res) => {
    if (req.url === '/') return res.end('<html><script src="/js/app.123.js"></script></html>');
    if (req.url === '/js/app.123.js') return res.end(SCRIPT);
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const { calls, getJson } = fakeHospital();
  try {
    const out = await discoverRecordSources({
      getJson,
      patientId: '1',
      hospitalNumber: 'PSSH/1',
      webAppUrl: `http://127.0.0.1:${web.address().port}/`,
      apiBaseUrl: 'http://127.0.0.1/api/',
    });
    const byType = Object.fromEntries(out.sources.map((s) => [s.resourceType, s]));
    assert.equal(byType.Encounter.path, 'visits/all/get?search={hospitalNumber}&currentPage=1&pageLimit=50');
    assert.equal(byType.Observation.path, 'visits/prescriptions/{visitId}');
    assert.equal(byType.Observation.listPath, 'data.tests');
    assert.equal(byType.Observation.titleField, 'test.name');
    assert.equal(byType.MedicationRequest.listPath, 'data.drugs');
    assert.equal(byType.AllergyIntolerance.path, 'patients/allergies/{patientId}');
    assert.equal(out.sources.filter((s) => s.resourceType === 'Observation').length, 1); // orders copy not added
    assert.ok(!out.sources.some((s) => s.resourceType === 'DocumentReference')); // other patient's notes
    assert.ok(out.sources.every((s) => s.patientField === 'patient_id'));
    assert.ok(!calls.some((c) => /generate|delete|stats/.test(c)));
  } finally {
    web.close();
  }
});

test('a web app on another computer is refused', async () => {
  const { getJson } = fakeHospital();
  const out = await discoverRecordSources({ getJson, patientId: '1', hospitalNumber: 'PSSH/1', webAppUrl: 'http://10.9.9.9/', apiBaseUrl: 'http://127.0.0.1/api/' });
  assert.match(out.steps[0].detail, /same computer/);
});
