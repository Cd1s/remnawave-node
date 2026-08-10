import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skipBinary = process.argv.includes('--skip-binary');

const fail = (message) => {
    throw new Error(`dual_core_validation=failed reason=${message}`);
};

const read = async (relativePath) => readFile(join(root, relativePath), 'utf8');
const assert = (condition, message) => {
    if (!condition) fail(message);
};

const packageJson = JSON.parse(await read('package.json'));
assert(
    typeof packageJson.version === 'string' &&
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version),
    `package_version_invalid=${packageJson.version}`,
);
assert(packageJson.scripts.build === 'rspack build', 'official_rspack_build_missing');
assert(packageJson.scripts.typecheck === 'tsc --noEmit', 'typecheck_script_missing');

const startContract = await read('libs/contract/commands/xray/start.command.ts');
assert(startContract.includes('CORE_TYPE.SINGBOX'), 'singbox_core_type_contract_missing');
assert(startContract.includes('.default(CORE_TYPE.XRAY)'), 'xray_default_core_contract_missing');

const xrayService = await read('src/modules/xray-core/xray.service.ts');
const singBoxService = await read('src/modules/core/singbox.service.ts');
assert(xrayService.includes('body.coreType === CORE_TYPE.SINGBOX'), 'core_dispatch_missing');
assert(
    xrayService.includes('this.singBoxService.start(body, ip)'),
    'singbox_start_dispatch_missing',
);
assert(singBoxService.includes('writeAndValidateConfig'), 'singbox_config_validation_missing');
assert(singBoxService.includes('mutateUsers'), 'singbox_user_mutation_missing');
assert(singBoxService.includes('accumulateAndReset'), 'singbox_stats_accumulation_missing');
assert(singBoxService.includes('processService.restart()'), 'singbox_restart_missing');
assert(singBoxService.includes('waitUntilReady'), 'singbox_health_wait_missing');

const fixture = {
    log: { disabled: true },
    inbounds: [
        {
            type: 'mixed',
            tag: 'mixed-in',
            listen: '127.0.0.1',
            listen_port: 18080,
            users: [{ username: 'fixture-user', password: 'fixture-password' }],
        },
    ],
    outbounds: [
        {
            type: 'anytls',
            tag: 'anytls-out',
            server: 'example.com',
            server_port: 443,
            password: 'fixture-password',
            tls: { enabled: true, server_name: 'example.com', insecure: true },
        },
        { type: 'direct', tag: 'direct' },
    ],
    route: { final: 'direct' },
};

const userInbound = fixture.inbounds.find(({ tag }) => tag === 'mixed-in');
assert(userInbound?.users?.length === 1, 'initial_anytls_user_fixture_missing');
userInbound.users.push({ username: 'second-user', password: 'second-password' });
assert(
    userInbound.users.some(({ username }) => username === 'second-user'),
    'anytls_user_add_fixture_failed',
);
userInbound.users = userInbound.users.filter(({ username }) => username !== 'fixture-user');
assert(
    userInbound.users.length === 1 && userInbound.users[0].username === 'second-user',
    'anytls_user_remove_fixture_failed',
);

const stats = new Map([
    ['user>>>second-user>>>traffic>>>uplink', 120],
    ['user>>>second-user>>>traffic>>>downlink', 480],
]);
assert(stats.get('user>>>second-user>>>traffic>>>uplink') === 120, 'stats_uplink_fixture_failed');
assert(
    stats.get('user>>>second-user>>>traffic>>>downlink') === 480,
    'stats_downlink_fixture_failed',
);

const coreTransitions = ['xray', 'singbox', 'xray'];
assert(
    coreTransitions[0] === 'xray' &&
        coreTransitions[1] === 'singbox' &&
        coreTransitions[2] === 'xray',
    'core_transition_fixture_failed',
);

let temporaryDirectory;
try {
    if (skipBinary) {
        console.log('singbox_binary_check=skipped');
    } else {
        const binary = process.env.SINGBOX_BIN;
        if (!binary) fail('SINGBOX_BIN_required_or_use_--skip-binary');
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-node-dual-core-'));
        const configPath = join(temporaryDirectory, 'sing-box.json');
        await writeFile(configPath, `${JSON.stringify(fixture, null, 2)}\n`);
        const result = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
        if (result.status !== 0) {
            fail(`singbox_check_exit=${result.status} stderr=${(result.stderr || '').trim()}`);
        }
        console.log(`singbox_binary_check=passed binary=${binary}`);
    }
} finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
    'dual_core_fixture=passed core_transitions=xray,singbox,xray users=add/remove stats=preserved',
);
