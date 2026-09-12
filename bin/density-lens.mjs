#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PNG } from 'pngjs';
import {
  DensityFunction,
  Holder,
  Identifier,
  NormalNoise,
  WorldgenRegistries,
} from 'deepslate';
import { XoroshiroRandom } from 'deepslate/math';

const usage = `Usage: density-lens <density-function.json> [options]

Render a Minecraft density function as a grayscale PNG.

The default is a terrain-style top-down heightmap. Use --mode slice only when
you want to inspect a horizontal X/Z slice at a fixed Y coordinate.

Options:
  --output, -o <file>     Output PNG (default: density-lens.png)
  --width, -w <pixels>    Image width (default: 256)
  --height, -h <pixels>   Image height (default: 256)
  --scale <blocks>        Distance between pixels (default: 4)
  --xz-scale <value>      X/Z scale for direct noise files (default: 1)
  --y-scale <value>       Y scale for direct noise files (default: 1)
  --origin-x <block>      World X at the image center (default: 0)
  --origin-z <block>      World Z at the image center (default: 0)
  --mode <height|slice>   Heightmap or fixed-Y slice (default: height)
  --y <block>             Y coordinate for slice mode (default: 0)
  --min-y <block>         Lowest Y searched by height mode (default: -64)
  --max-y <block>         Highest Y searched by height mode (default: 320)
  --threshold <value>     Density considered solid (default: 0)
  --seed <integer>        Noise seed (default: 0)
  --help                  Show this help
`;

function fail(message) {
  console.error(`density-lens: ${message}\n\n${usage}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help')) {
    console.log(usage);
    process.exit(0);
  }
  const input = path.resolve(argv[0]);
  const options = {
    output: 'density-lens.png', width: 256, height: 256, scale: 4,
    originX: 0, originZ: 0, mode: 'height', y: 0, minY: -64, maxY: 320,
    threshold: 0, seed: 0n, xzScale: 1, yScale: 1,
  };
  const names = new Map([
    ['-o', 'output'], ['--output', 'output'], ['-w', 'width'], ['--width', 'width'],
    ['-h', 'height'], ['--height', 'height'], ['--scale', 'scale'],
    ['--xz-scale', 'xzScale'], ['--y-scale', 'yScale'],
    ['--origin-x', 'originX'], ['--origin-z', 'originZ'], ['--mode', 'mode'],
    ['--y', 'y'], ['--min-y', 'minY'], ['--max-y', 'maxY'],
    ['--threshold', 'threshold'], ['--seed', 'seed'],
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const key = names.get(argv[i]);
    if (!key || i + 1 >= argv.length) throw new Error(`unknown or incomplete option: ${argv[i]}`);
    const value = argv[++i];
    if (key === 'output' || key === 'mode') options[key] = value;
    else if (key === 'seed') options.seed = BigInt(value);
    else options[key] = Number(value);
  }
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`);
  if (!['height', 'slice'].includes(options.mode)) throw new Error('--mode must be height or slice');
  for (const key of ['width', 'height', 'scale', 'xzScale', 'yScale']) if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be positive`);
  return { input, options };
}

function findDatapackRoot(input) {
  let current = path.dirname(input);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === 'worldgen') return path.dirname(path.dirname(path.dirname(current)));
    current = path.dirname(current);
  }
  return null;
}

function idForFile(file, root, kind) {
  const relative = path.relative(path.join(root, 'data'), file).replaceAll('\\', '/');
  const marker = `/worldgen/${kind}/`;
  const index = relative.indexOf(marker);
  if (index < 0) return null;
  const namespace = relative.slice(0, index);
  const name = relative.slice(index + marker.length).replace(/\.json$/, '');
  return Identifier.parse(`${namespace}:${name}`);
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(file) : entry.name.endsWith('.json') ? [file] : [];
  });
}

function loadDatapack(input) {
  const root = findDatapackRoot(input);
  const noiseFiles = root ? jsonFiles(path.join(root, 'data')).filter(file => file.includes(`${path.sep}worldgen${path.sep}noise${path.sep}`)) : [];
  const densityFiles = root ? jsonFiles(path.join(root, 'data')).filter(file => file.includes(`${path.sep}worldgen${path.sep}density_function${path.sep}`)) : [input];
  WorldgenRegistries.NOISE.clear();
  WorldgenRegistries.DENSITY_FUNCTION.clear();
  for (const file of noiseFiles) {
    const id = idForFile(file, root, 'noise');
    if (id) WorldgenRegistries.NOISE.register(id, () => WorldgenRegistries.NOISE.parse(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  for (const file of densityFiles) {
    const id = root ? idForFile(file, root, 'density_function') : Identifier.create(path.basename(input, '.json'));
    if (id) WorldgenRegistries.DENSITY_FUNCTION.register(id, () => DensityFunction.fromJson(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const densityId = root ? idForFile(input, root, 'density_function') : null;
  const noiseId = root ? idForFile(input, root, 'noise') : null;
  const kind = noiseId || (raw && typeof raw === 'object' && Object.hasOwn(raw, 'base_octave')) ? 'noise' : 'density';
  return { root, raw, id: kind === 'noise' ? noiseId : densityId, kind };
}

function hashId(id) {
  let hash = 2166136261n;
  for (const char of id) hash = BigInt.asIntN(64, (hash ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  return hash;
}

function bindNoise(density, seed) {
  return density.mapAll({ apply(node) {
    if (node instanceof DensityFunction.HolderHolder) {
      return bindNoise(node.holder.value(), seed);
    }
    if (!(node instanceof DensityFunction.NoiseFunction)) return node;
    const key = node.noise.key()?.toString() ?? 'minecraft:anonymous';
    const sampler = node.noise.value().create(XoroshiroRandom.create(seed ^ hashId(key)));
    return new DensityFunction.NoiseFunction(node.noise, node.xzScale, node.yScale, node.shiftX, node.shiftY, node.shiftZ, sampler);
  }});
}

function render(density, options) {
  const values = new Float64Array(options.width * options.height);
  let min = Infinity; let max = -Infinity;
  let surfaceHits = 0;
  for (let row = 0; row < options.height; row += 1) {
    for (let column = 0; column < options.width; column += 1) {
      const x = options.originX + (column - (options.width - 1) / 2) * options.scale;
      const z = options.originZ + (row - (options.height - 1) / 2) * options.scale;
      let value;
      if (options.mode === 'slice') {
        value = density.compute({ x, y: options.y, z });
      } else {
        value = options.minY;
        for (let y = options.maxY; y >= options.minY; y -= 1) {
          if (density.compute({ x, y, z }) > options.threshold) {
            value = y;
            surfaceHits += 1;
            break;
          }
        }
      }
      const index = row * options.width + column;
      values[index] = value;
      min = Math.min(min, value); max = Math.max(max, value);
    }
  }
  const png = new PNG({ width: options.width, height: options.height });
  const span = max - min || 1;
  for (let i = 0; i < values.length; i += 1) {
    const gray = Math.max(0, Math.min(255, Math.round(((values[i] - min) / span) * 255)));
    const pixel = i * 4;
    png.data[pixel] = gray;
    png.data[pixel + 1] = gray;
    png.data[pixel + 2] = gray;
    png.data[pixel + 3] = 255;
  }
  return { png, min, max, surfaceHits };
}

try {
  const { input, options } = parseArgs(process.argv.slice(2));
  const loaded = loadDatapack(input);
  let parsed;
  if (loaded.kind === 'noise') {
    const noise = loaded.id ? WorldgenRegistries.NOISE.getOrThrow(loaded.id) : NormalNoise.fromJson(loaded.raw);
    const noiseId = loaded.id ?? Identifier.create('direct_noise');
    parsed = new DensityFunction.NoiseFunction(
      Holder.direct(noise, noiseId), options.xzScale, options.yScale,
      DensityFunction.Constant.ZERO, DensityFunction.Constant.ZERO, DensityFunction.Constant.ZERO,
    );
  } else {
    parsed = loaded.id ? WorldgenRegistries.DENSITY_FUNCTION.getOrThrow(loaded.id) : DensityFunction.fromJson(loaded.raw);
  }
  const density = bindNoise(parsed, options.seed);
  const { png, min, max, surfaceHits } = render(density, options);
  const output = path.resolve(options.output);
  fs.writeFileSync(output, PNG.sync.write(png));
  console.log(`Rendered ${input}`);
  console.log(`  mode=${options.mode} size=${options.width}x${options.height} range=${min}..${max}`);
  if (options.mode === 'height') {
    const total = options.width * options.height;
    console.log(`  surface hits=${surfaceHits}/${total} (${(surfaceHits / total * 100).toFixed(1)}%)`);
    if (surfaceHits === 0 || surfaceHits === total) {
      console.warn('  warning: this density function does not cross the threshold over the requested Y range; try --mode slice for a noise-field view.');
    }
  }
  console.log(`  wrote ${output}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
