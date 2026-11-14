#!/usr/bin/env node
'use strict';

/**
 * fit-curve.js -- least-squares fit of the Section 3.5.2 cost model
 *
 *     Caction(b) = A + Co / b,     A = Ce + Cv
 *
 * to Caliper measurements taken at several orderer batch sizes b.
 * The model is linear in x = 1/b, so ordinary least squares on
 * (x, y) gives A (intercept, the asymptote as b -> infinity) and Co (slope).
 *
 * INPUT (one of)
 *   --results <dir>   A sweep directory written by scripts/run-batch-sweep.sh:
 *                     <dir>/b-<n>/report.html (or caliper.log) and, when
 *                     present, <dir>/b-<n>/raw/*.json (ms-precision stats from
 *                     the workload modules; preferred over the report, whose
 *                     latencies are rounded to 10 ms).
 *   --csv <file>      A simple CSV, '#' lines ignored, header required:
 *                         b,value_ms                 one series
 *                         function,b,value_ms        one series per function
 *                     `throughput_tps` may be given instead of `value_ms`;
 *                     it is converted to ms per transaction (1000 / tps).
 *                     `avg_latency_ms` is accepted as a synonym of value_ms.
 *
 * OPTIONS (results mode)
 *   --metric invtps   (default) y = 1000 / committed-throughput, i.e. ms of
 *                     ledger pipeline time per committed transaction. Use with
 *                     the saturating -max rounds, where every block is cut by
 *                     count so b_eff = MaxMessageCount.
 *   --metric latency  y = mean commit latency (ms). Includes the time a
 *                     transaction waits for its block to fill, so it is NOT
 *                     Caction(b); reported for Table 3.9's latency column.
 *   --rounds <regex>  Which round labels to use (default: "-max$" for invtps,
 *                     "^(?!checkAccess)" for latency).
 *   --batch-timeout <s>  BatchTimeout in seconds, for b_eff of fixed-rate rounds
 *                     (default: from results/b-<n>/meta.txt, else 2).
 *
 * OUTPUT
 *   Prints A (= Ce + Cv), Co, R^2 per function and pooled ("all"), and a
 *   Ce/Cv split when checkAccess (query) rounds are present. With
 *   --out <dir> also writes:
 *     fit-points.csv   group,label,b_nominal,b_eff,observed_ms,fitted_ms,residual_ms
 *     fit-curve.csv    group,b,fitted_ms,asymptote_ms   (b = 1..max, for charts)
 *     fit-summary.json everything above, machine-readable
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ args

function parseArgs(argv) {
    const opts = { metric: 'invtps' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) {
                fail(`${a} needs a value`);
            }
            return argv[++i];
        };
        switch (a) {
        case '--results': opts.results = next(); break;
        case '--csv': opts.csv = next(); break;
        case '--out': opts.out = next(); break;
        case '--metric': opts.metric = next(); break;
        case '--rounds': opts.rounds = next(); break;
        case '--batch-timeout': opts.batchTimeout = Number(next()); break;
        case '--max-b': opts.maxB = Number(next()); break;
        case '-h': case '--help': usage(0); break;
        default: fail(`Unknown argument ${a}`);
        }
    }
    if (!opts.results === !opts.csv) {
        fail('Give exactly one of --results <dir> or --csv <file>');
    }
    if (!['invtps', 'latency'].includes(opts.metric)) {
        fail('--metric must be invtps or latency');
    }
    return opts;
}

function usage(code) {
    const src = fs.readFileSync(__filename, 'utf8');
    const m = src.match(/\/\*\*([\s\S]*?)\*\//);
    process.stdout.write(m ? m[1].replace(/^ \* ?/gm, '') + '\n' : 'see source\n');
    process.exit(code);
}

function fail(msg) {
    process.stderr.write(`fit-curve: ${msg}\n`);
    process.exit(1);
}

// ------------------------------------------------------------------ fit

/** OLS of y = A + Co * (1/b). */
function fitModel(points) {
    const n = points.length;
    if (n < 2) {
        return null;
    }
    const xs = points.map((p) => 1 / p.b);
    const ys = points.map((p) => p.y);
    const mx = xs.reduce((a, v) => a + v, 0) / n;
    const my = ys.reduce((a, v) => a + v, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
        sxx += (xs[i] - mx) ** 2;
        sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx === 0) {
        return null; // every point at the same b: the slope is undetermined
    }
    const Co = sxy / sxx;
    const A = my - Co * mx;
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
        const f = A + Co * xs[i];
        ssRes += (ys[i] - f) ** 2;
        ssTot += (ys[i] - my) ** 2;
    }
    // Standard errors of the two coefficients (needs n > 2).
    let seA = null;
    let seCo = null;
    if (n > 2) {
        const s2 = ssRes / (n - 2);
        seCo = Math.sqrt(s2 / sxx);
        seA = Math.sqrt(s2 * (1 / n + (mx * mx) / sxx));
    }
    return {
        A,
        Co,
        r2: ssTot > 0 ? 1 - ssRes / ssTot : 1,
        rmse: Math.sqrt(ssRes / n),
        seA,
        seCo,
        n,
        distinctB: new Set(points.map((p) => p.b)).size,
    };
}

// ------------------------------------------------------------- CSV mode

function splitCsvLine(line) {
    return line.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
}

function loadCsv(file) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (lines.length < 2) {
        fail(`${file}: needs a header and at least two data rows`);
    }
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const bi = header.indexOf('b');
    const fi = header.indexOf('function');
    let vi = header.indexOf('value_ms');
    if (vi < 0) {
        vi = header.indexOf('avg_latency_ms');
    }
    const ti = header.indexOf('throughput_tps');
    if (bi < 0 || (vi < 0 && ti < 0)) {
        fail(`${file}: header must contain "b" and "value_ms" (or "avg_latency_ms" / "throughput_tps")`);
    }
    return lines.slice(1).map((line, k) => {
        const c = splitCsvLine(line);
        const b = Number(c[bi]);
        const y = vi >= 0 ? Number(c[vi]) : 1000 / Number(c[ti]);
        if (!(b > 0) || !Number.isFinite(y)) {
            fail(`${file}: bad row ${k + 2}: ${line}`);
        }
        return {
            group: fi >= 0 ? c[fi] : 'series',
            label: `${fi >= 0 ? c[fi] : 'series'}@b${b}`,
            bNominal: b,
            b,
            y,
        };
    });
}

// --------------------------------------------------------- results mode

const NUM = /^-?\d+(\.\d+)?$/;

/** Rows of Caliper's 8-column result table, in round order. */
function parseReportHtml(html) {
    const rows = [];
    const seen = new Set();
    const trRe = /<tr>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = trRe.exec(html))) {
        const cells = [...m[1].matchAll(/<td>\s*([\s\S]*?)\s*<\/td>/g)].map((x) => x[1].trim());
        if (cells.length === 8 && NUM.test(cells[1]) && !seen.has(cells[0])) {
            seen.add(cells[0]);
            rows.push(rowFromCells(cells));
        }
    }
    return rows;
}

function parseCaliperLog(text) {
    const byName = new Map();
    for (const line of text.split(/\r?\n/)) {
        const start = line.indexOf('|');
        if (start < 0) {
            continue;
        }
        const cells = line.slice(start).split('|').slice(1, -1).map((s) => s.trim());
        if (cells.length === 8 && NUM.test(cells[1])) {
            byName.set(cells[0], rowFromCells(cells)); // last table (summary) wins
        }
    }
    return [...byName.values()];
}

function rowFromCells(c) {
    const num = (s) => (NUM.test(s) ? Number(s) : null);
    return {
        label: c[0],
        succ: num(c[1]),
        fail: num(c[2]),
        sendRate: num(c[3]),
        avgLatencyMs: num(c[6]) === null ? null : num(c[6]) * 1000,
        throughput: num(c[7]),
    };
}

/** Merge the per-worker raw stat files into one record per round index. */
function loadRaw(dir) {
    const byRound = new Map();
    if (!fs.existsSync(dir)) {
        return byRound;
    }
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const agg = byRound.get(r.roundIndex) || { name: r.name, succ: 0, fail: 0, latSum: 0, latN: 0, first: null, last: null };
        agg.succ += r.succ;
        agg.fail += r.fail;
        agg.latSum += r.latencyMs.sum || 0;
        agg.latN += r.latencyMs.n || 0;
        if (r.firstCreateMs && (agg.first === null || r.firstCreateMs < agg.first)) {
            agg.first = r.firstCreateMs;
        }
        if (r.lastFinalMs && (agg.last === null || r.lastFinalMs > agg.last)) {
            agg.last = r.lastFinalMs;
        }
        byRound.set(r.roundIndex, agg);
    }
    return byRound;
}

function readMeta(dir) {
    const meta = {};
    const f = path.join(dir, 'meta.txt');
    if (fs.existsSync(f)) {
        for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
            const i = line.indexOf('=');
            if (i > 0) {
                meta[line.slice(0, i)] = line.slice(i + 1);
            }
        }
    }
    return meta;
}

function parseDuration(s) {
    const m = /^([\d.]+)\s*(ms|s|m)?$/.exec(String(s || '').trim());
    if (!m) {
        return null;
    }
    const v = Number(m[1]);
    return m[2] === 'ms' ? v / 1000 : m[2] === 'm' ? v * 60 : v;
}

function loadResults(dir, opts) {
    const subdirs = fs.readdirSync(dir).filter((d) => /^b-\d+$/.test(d)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    if (subdirs.length === 0) {
        fail(`${dir}: no b-<n> subdirectories found`);
    }
    const rounds = [];
    for (const sub of subdirs) {
        const bdir = path.join(dir, sub);
        const b = Number(sub.slice(2));
        const meta = readMeta(bdir);
        const timeout = opts.batchTimeout || parseDuration(meta.BatchTimeout) || 2;
        let rows = [];
        if (fs.existsSync(path.join(bdir, 'report.html'))) {
            rows = parseReportHtml(fs.readFileSync(path.join(bdir, 'report.html'), 'utf8'));
        }
        if (rows.length === 0 && fs.existsSync(path.join(bdir, 'caliper.log'))) {
            rows = parseCaliperLog(fs.readFileSync(path.join(bdir, 'caliper.log'), 'utf8'));
        }
        const raw = loadRaw(path.join(bdir, 'raw'));
        if (rows.length === 0 && raw.size === 0) {
            process.stderr.write(`fit-curve: ${bdir}: no report.html, caliper.log or raw/ stats -- skipped\n`);
            continue;
        }
        // Report rows are in round order, so row i <-> raw roundIndex i.
        const n = Math.max(rows.length, raw.size ? Math.max(...raw.keys()) + 1 : 0);
        for (let i = 0; i < n; i++) {
            const rep = rows[i] || {};
            const rw = raw.get(i);
            const label = rep.label || (rw ? `${rw.name}-round${i}` : `round${i}`);
            let succ = rep.succ;
            let latencyMs = rep.avgLatencyMs;
            let succTps = rep.throughput !== null && rep.throughput !== undefined && rep.succ + rep.fail > 0
                ? rep.throughput * (rep.succ / (rep.succ + rep.fail))
                : null;
            let source = 'report';
            if (rw && rw.succ > 0 && rw.last > rw.first) {
                succ = rw.succ;
                latencyMs = rw.latN ? rw.latSum / rw.latN : latencyMs;
                succTps = rw.succ / ((rw.last - rw.first) / 1000);
                source = 'raw';
            }
            const saturated = /-max$/.test(label);
            const bEff = saturated || !rep.sendRate ? b : Math.max(1, Math.min(b, rep.sendRate * timeout));
            rounds.push({
                group: label.split('-')[0],
                label,
                bNominal: b,
                b: bEff,
                succ,
                fail: rw ? rw.fail : rep.fail,
                sendRate: rep.sendRate,
                latencyMs,
                succTps,
                source,
            });
        }
    }
    return rounds;
}

// ------------------------------------------------------------------ main

function fmt(v, d = 2) {
    return v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d);
}

function currentDefaults() {
    try {
        // eslint-disable-next-line global-require
        return require(path.join(__dirname, '..', '..', '..', 'backend', 'src', 'services', 'costModel.js')).DEFAULT_PARAMS;
    } catch (err) {
        return null;
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));

    let points;
    let ceProxy = null;
    if (opts.csv) {
        points = loadCsv(opts.csv);
    } else {
        const rounds = loadResults(opts.results, opts);
        const queries = rounds.filter((r) => r.group === 'checkAccess' && r.latencyMs);
        if (queries.length) {
            ceProxy = queries.reduce((a, r) => a + r.latencyMs, 0) / queries.length;
        }
        const defaultRe = opts.metric === 'invtps' ? '-max$' : '^(?!checkAccess)';
        const re = new RegExp(opts.rounds || defaultRe);
        points = rounds
            .filter((r) => re.test(r.label) && r.succ > 0)
            .map((r) => ({
                ...r,
                y: opts.metric === 'invtps' ? (r.succTps ? 1000 / r.succTps : NaN) : r.latencyMs,
            }))
            .filter((r) => Number.isFinite(r.y));
        console.log(`Loaded ${rounds.length} rounds from ${opts.results}; ${points.length} match /${re.source}/ with metric=${opts.metric}`);
    }
    if (points.length === 0) {
        fail('no usable data points');
    }

    const groups = new Map();
    for (const p of points) {
        if (!groups.has(p.group)) {
            groups.set(p.group, []);
        }
        groups.get(p.group).push(p);
    }
    if (groups.size > 1) {
        groups.set('all', points);
    }

    const unit = opts.csv ? 'ms' : opts.metric === 'invtps' ? 'ms/tx (1000/TPS)' : 'ms latency';
    console.log(`\nCaction(b) = A + Co/b   least-squares fit, y in ${unit}\n`);
    console.log(['group'.padEnd(26), 'n', 'b-values', 'A=Ce+Cv', '+/-', 'Co', '+/-', 'R^2', 'RMSE'].join('\t'));
    const fits = {};
    for (const [g, pts] of groups) {
        const fit = fitModel(pts);
        fits[g] = fit;
        if (!fit) {
            console.log(`${g.padEnd(26)}\t${pts.length}\t(needs >= 2 distinct b values -- skipped)`);
            continue;
        }
        const bs = [...new Set(pts.map((p) => +p.b.toFixed(1)))].sort((a, b) => a - b).join(' ');
        console.log([g.padEnd(26), fit.n, bs, fmt(fit.A), fmt(fit.seA), fmt(fit.Co), fmt(fit.seCo), fmt(fit.r2, 3), fmt(fit.rmse)].join('\t'));
        if (fit.Co < 0) {
            console.log(`  ! ${g}: Co < 0 -- cost rises with b; the rounds were probably not saturated (check the -max rounds' throughput) or b_eff is wrong.`);
        }
        if (fit.A < 0) {
            console.log(`  ! ${g}: A < 0 -- not physically meaningful; collect more b values or more transactions per round.`);
        }
    }

    const headline = fits.all || fits[[...groups.keys()][0]];
    if (headline && !opts.csv && opts.metric === 'latency') {
        console.log('\nmetric=latency: commit latency includes waiting for the block to fill, so this fit is');
        console.log('descriptive only and must NOT be used as Ce/Cv/Co. Use the default metric (invtps) for that.');
    } else if (headline) {
        console.log(`\nHeadline (${fits.all ? 'pooled over all functions' : [...groups.keys()][0]}):  Ce + Cv = ${fmt(headline.A)} ms,  Co = ${fmt(headline.Co)} ms`);
        if (ceProxy !== null) {
            console.log(`CheckAccess query latency (endorsement/execution only, no ordering/validation): ${fmt(ceProxy)} ms`);
            console.log(`  -> Ce ~ ${fmt(ceProxy)} ms,  Cv ~ A - Ce = ${fmt(headline.A - ceProxy)} ms   (rough split; see README)`);
        } else {
            console.log('No checkAccess rounds found: A is Ce + Cv combined (see README for splitting it).');
        }
        const cur = currentDefaults();
        if (cur) {
            console.log(`Current backend DEFAULT_PARAMS: Ce=${cur.Ce} Cv=${cur.Cv} Co=${cur.Co} (Ce+Cv=${cur.Ce + cur.Cv})`);
        }
    }

    if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        const pointRows = ['group,label,b_nominal,b_eff,observed_ms,fitted_ms,residual_ms'];
        for (const [g, pts] of groups) {
            const fit = fits[g];
            for (const p of pts) {
                const f = fit ? fit.A + fit.Co / p.b : NaN;
                pointRows.push([g, p.label, p.bNominal, fmt(p.b, 3), fmt(p.y, 3), fmt(f, 3), fmt(p.y - f, 3)].join(','));
            }
        }
        fs.writeFileSync(path.join(opts.out, 'fit-points.csv'), pointRows.join('\n') + '\n');

        const maxB = opts.maxB || Math.max(50, ...points.map((p) => Math.ceil(p.b)));
        const curveRows = ['group,b,fitted_ms,asymptote_ms'];
        for (const [g, fit] of Object.entries(fits)) {
            if (!fit) {
                continue;
            }
            for (let b = 1; b <= maxB; b++) {
                curveRows.push([g, b, fmt(fit.A + fit.Co / b, 3), fmt(fit.A, 3)].join(','));
            }
        }
        fs.writeFileSync(path.join(opts.out, 'fit-curve.csv'), curveRows.join('\n') + '\n');

        fs.writeFileSync(path.join(opts.out, 'fit-summary.json'), JSON.stringify({
            generatedAt: new Date().toISOString(),
            input: opts.csv || opts.results,
            metric: opts.csv ? 'csv' : opts.metric,
            fits,
            checkAccessLatencyMs: ceProxy,
            points,
        }, null, 2) + '\n');
        console.log(`\nWrote ${path.join(opts.out, 'fit-points.csv')}, fit-curve.csv and fit-summary.json`);
    }
}

main();
