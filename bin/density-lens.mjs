#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PNG } from "pngjs";
import {
  DensityFunction,
  Holder,
  Identifier,
  NormalNoise,
  WorldgenRegistries,
} from "deepslate";
import { XoroshiroRandom } from "deepslate/math";

const usage = `Usage: density-lens <density-function.json> [options]

Render a Minecraft density function as a grayscale PNG.

The default is selected from the input: density functions render heightmaps,
and noise files render top-down noise maps. Use --mode density or --mode noise
to choose explicitly.

Options:
  --output, -o <file>     Output PNG (default: density-lens.png)
  --width, -w <pixels>    Image width (default: 512)
  --height, -h <pixels>   Image height (default: 512)
  --scale <blocks>        Distance between pixels (default: 1)
  --xz-scale <value>      X/Z scale for direct noise files (default: 1)
  --y-scale <value>       Y scale for direct noise files (default: 1)
  --origin-x <block>      World X at the image center (default: 0)
  --origin-z <block>      World Z at the image center (default: 0)
  --mode <density|noise>  Density heightmap or noise map (default: auto)
  --y <block>             Y coordinate for noise mode (default: 0)
  --min-y <block>         Lowest Y searched by density mode (default: -64)
  --max-y <block>         Highest Y searched by density mode (default: 320)
  --y-step <blocks>       Vertical search step for density mode (default: 4)
  --sea-level <block>     Tint heightmap pixels below this Y blue
  --threshold <value>     Density considered solid (default: 0)
  --seed <integer>        Noise seed (default: 0)
  --help                  Show this help
`;

function fail(message) {
  console.error(`density-lens: ${message}\n\n${usage}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(usage);
    process.exit(0);
  }
  const input = path.resolve(argv[0]);
  const options = {
    output: "density-lens.png",
    width: 512,
    height: 512,
    scale: 1,
    originX: 0,
    originZ: 0,
    mode: "auto",
    y: 0,
    minY: -64,
    maxY: 320,
    yStep: 4,
    seaLevel: null,
    threshold: 0,
    seed: 0n,
    xzScale: 1,
    yScale: 1,
  };
  const names = new Map([
    ["-o", "output"],
    ["--output", "output"],
    ["-w", "width"],
    ["--width", "width"],
    ["-h", "height"],
    ["--height", "height"],
    ["--scale", "scale"],
    ["--xz-scale", "xzScale"],
    ["--y-scale", "yScale"],
    ["--origin-x", "originX"],
    ["--origin-z", "originZ"],
    ["--mode", "mode"],
    ["--y", "y"],
    ["--min-y", "minY"],
    ["--max-y", "maxY"],
    ["--y-step", "yStep"],
    ["--sea-level", "seaLevel"],
    ["--threshold", "threshold"],
    ["--seed", "seed"],
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const key = names.get(argv[i]);
    if (!key || i + 1 >= argv.length)
      throw new Error(`unknown or incomplete option: ${argv[i]}`);
    const value = argv[++i];
    if (key === "output" || key === "mode") options[key] = value;
    else if (key === "seed") options.seed = BigInt(value);
    else options[key] = Number(value);
  }
  if (!fs.existsSync(input)) throw new Error(`input file not found: ${input}`);
  if (!["auto", "density", "noise"].includes(options.mode))
    throw new Error("--mode must be density or noise");
  for (const key of ["width", "height", "scale", "xzScale", "yScale", "yStep"])
    if (!Number.isFinite(options[key]) || options[key] <= 0)
      throw new Error(`--${key} must be positive`);
  return { input, options };
}

function findDatapackRoot(input) {
  let current = path.dirname(input);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "worldgen")
      return path.dirname(path.dirname(path.dirname(current)));
    current = path.dirname(current);
  }
  return null;
}

function idForFile(file, root, kind) {
  const relative = path
    .relative(path.join(root, "data"), file)
    .replaceAll("\\", "/");
  const marker = `/worldgen/${kind}/`;
  const index = relative.indexOf(marker);
  if (index < 0) return null;
  const namespace = relative.slice(0, index);
  const name = relative.slice(index + marker.length).replace(/\.json$/, "");
  return Identifier.parse(`${namespace}:${name}`);
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? jsonFiles(file)
      : entry.name.endsWith(".json")
        ? [file]
        : [];
  });
}

function loadDatapack(input) {
  const root = findDatapackRoot(input);
  const noiseFiles = root
    ? jsonFiles(path.join(root, "data")).filter((file) =>
        file.includes(`${path.sep}worldgen${path.sep}noise${path.sep}`),
      )
    : [];
  const densityFiles = root
    ? jsonFiles(path.join(root, "data")).filter((file) =>
        file.includes(
          `${path.sep}worldgen${path.sep}density_function${path.sep}`,
        ),
      )
    : [input];
  WorldgenRegistries.NOISE.clear();
  WorldgenRegistries.DENSITY_FUNCTION.clear();
  const densitySources = new Map();
  for (const file of noiseFiles) {
    const id = idForFile(file, root, "noise");
    if (id)
      WorldgenRegistries.NOISE.register(id, () =>
        WorldgenRegistries.NOISE.parse(
          JSON.parse(fs.readFileSync(file, "utf8")),
        ),
      );
  }
  for (const file of densityFiles) {
    const id = root
      ? idForFile(file, root, "density_function")
      : Identifier.create(path.basename(input, ".json"));
    if (id) {
      const source = JSON.parse(fs.readFileSync(file, "utf8"));
      densitySources.set(id.toString(), source);
      WorldgenRegistries.DENSITY_FUNCTION.register(id, () =>
        DensityFunction.fromJson(source),
      );
    }
  }
  const raw = JSON.parse(fs.readFileSync(input, "utf8"));
  const densityId = root ? idForFile(input, root, "density_function") : null;
  const noiseId = root ? idForFile(input, root, "noise") : null;
  const kind =
    noiseId ||
    (raw && typeof raw === "object" && Object.hasOwn(raw, "base_octave"))
      ? "noise"
      : "density";
  return { root, raw, id: kind === "noise" ? noiseId : densityId, kind, densitySources };
}

function assertNoDensityCycles(id, sources, visiting = [], visited = new Set()) {
  if (!sources.has(id) || visited.has(id)) return;
  if (visiting.includes(id)) {
    throw new Error(`cyclic density-function reference: ${[...visiting, id].join(" -> ")}`);
  }
  const source = sources.get(id);
  const nextVisiting = [...visiting, id];
  const inspect = (value, fieldName = undefined) => {
    if (fieldName === "noise" || fieldName === "type") return;
    if (typeof value === "string" && sources.has(value)) {
      assertNoDensityCycles(value, sources, nextVisiting, visited);
    } else if (Array.isArray(value)) {
      for (const item of value) inspect(item);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) inspect(item, key);
    }
  };
  inspect(source);
  visited.add(id);
}

function bindNoise(density, seed, activeReferences = new Set()) {
  const positionalRandom = XoroshiroRandom.create(seed).forkPositional();
  return density.mapAll({
    apply(node) {
      if (node instanceof DensityFunction.HolderHolder) {
        const key = node.holder.key()?.toString() ?? "<anonymous>";
        if (activeReferences.has(key)) {
          const chain = [...activeReferences, key].join(" -> ");
          throw new Error(`cyclic density-function reference: ${chain}`);
        }
        const nextReferences = new Set(activeReferences);
        nextReferences.add(key);
        return bindNoise(node.holder.value(), seed, nextReferences);
      }
      if (!(node instanceof DensityFunction.NoiseFunction)) return node;
      const key = node.noise.key()?.toString() ?? "minecraft:anonymous";
      const sampler = node.noise
        .value()
        .create(positionalRandom.fromHashOf(key));
      return new DensityFunction.NoiseFunction(
        node.noise,
        node.xzScale,
        node.yScale,
        node.shiftX,
        node.shiftY,
        node.shiftZ,
        sampler,
      );
    },
  });
}

function createGradientHeightModel(density, options) {
  if (!(density instanceof DensityFunction.Binary) || !["add", "sub"].includes(density.type)) return null;
  let base;
  let gradient;
  let baseSign;
  let gradientSign;
  if (density.left instanceof DensityFunction.Gradient && density.left.axis === "y" && density.left.tiling === "clamp_to_edge") {
    gradient = density.left;
    base = density.right;
    baseSign = density.type === "add" ? 1 : -1;
    gradientSign = 1;
  } else if (density.right instanceof DensityFunction.Gradient && density.right.axis === "y" && density.right.tiling === "clamp_to_edge") {
    gradient = density.right;
    base = density.left;
    baseSign = 1;
    gradientSign = density.type === "add" ? 1 : -1;
  } else {
    return null;
  }
  const sample = (y) => base.compute({ x: 0, y, z: 0 });
  if (sample(options.minY) !== sample(options.maxY)) return null;
  return (x, z) => {
    const baseValue = base.compute({ x, y: 0, z });
    const evaluate = (y) => baseSign * baseValue + gradientSign * gradient.compute({ x, y, z });
    const lowValue = evaluate(options.minY);
    const highValue = evaluate(options.maxY);
    if (highValue > options.threshold) return { value: options.maxY, hit: true };
    if (lowValue <= options.threshold) return { value: options.minY, hit: false };
    let low = options.minY;
    let high = options.maxY;
    while (high - low > 1) {
      const candidate = Math.floor((low + high) / 2);
      if (evaluate(candidate) > options.threshold) low = candidate;
      else high = candidate;
    }
    return { value: low, hit: true };
  };
}

function render(density, options) {
  const values = new Float64Array(options.width * options.height);
  let min = Infinity;
  let max = -Infinity;
  let surfaceHits = 0;
  const gradientHeightModel = options.mode === "density" ? createGradientHeightModel(density, options) : null;
  for (let row = 0; row < options.height; row += 1) {
    for (let column = 0; column < options.width; column += 1) {
      const x =
        options.originX + (column - (options.width - 1) / 2) * options.scale;
      const z =
        options.originZ + (row - (options.height - 1) / 2) * options.scale;
      let value;
      if (options.mode === "noise") {
        value = density.compute({ x, y: options.y, z });
      } else if (gradientHeightModel) {
        const result = gradientHeightModel(x, z);
        value = result.value;
        if (result.hit) surfaceHits += 1;
      } else {
        const bottom = density.compute({ x, y: options.minY, z });
        const middleY = Math.floor((options.minY + options.maxY) / 2);
        const middle = density.compute({ x, y: middleY, z });
        const top = density.compute({ x, y: options.maxY, z });
        if (bottom === middle && middle === top) {
          value = top > options.threshold ? options.maxY : options.minY;
          if (top > options.threshold) surfaceHits += 1;
        } else if (
          bottom > options.threshold &&
          top <= options.threshold &&
          bottom >= middle &&
          middle >= top
        ) {
          let low = options.minY;
          let high = options.maxY;
          while (high - low > 1) {
            const candidate = Math.floor((low + high) / 2);
            if (density.compute({ x, y: candidate, z }) > options.threshold) low = candidate;
            else high = candidate;
          }
          value = low;
          surfaceHits += 1;
        } else {
          value = options.minY;
          if (top > options.threshold) {
            value = options.maxY;
            surfaceHits += 1;
          } else {
            for (let y = options.maxY - options.yStep; y >= options.minY; y -= options.yStep) {
              if (density.compute({ x, y, z }) > options.threshold) {
                value = y;
                for (let refineY = Math.min(y + options.yStep - 1, options.maxY - 1); refineY >= y; refineY -= 1) {
                  if (density.compute({ x, y: refineY, z }) > options.threshold) {
                    value = refineY;
                    break;
                  }
                }
                surfaceHits += 1;
                break;
              }
            }
          }
        }
      }
      const index = row * options.width + column;
      values[index] = value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  const png = new PNG({ width: options.width, height: options.height });
  const span = max - min || 1;
  for (let i = 0; i < values.length; i += 1) {
    const gray = Math.max(
      0,
      Math.min(255, Math.round(((values[i] - min) / span) * 255)),
    );
    const pixel = i * 4;
    const underwater = options.mode === "density" && options.seaLevel !== null && values[i] < options.seaLevel;
    png.data[pixel] = underwater ? Math.round(gray * 0.35) : gray;
    png.data[pixel + 1] = underwater ? Math.round(gray * 0.55) : gray;
    png.data[pixel + 2] = underwater ? Math.max(gray, 160) : gray;
    png.data[pixel + 3] = 255;
  }
  return { png, min, max, surfaceHits };
}

try {
  const { input, options } = parseArgs(process.argv.slice(2));
  const loaded = loadDatapack(input);
  if (loaded.kind === "density" && loaded.id) {
    assertNoDensityCycles(loaded.id.toString(), loaded.densitySources);
  }
  let parsed;
  if (loaded.kind === "noise") {
    const noise = loaded.id
      ? WorldgenRegistries.NOISE.getOrThrow(loaded.id)
      : NormalNoise.fromJson(loaded.raw);
    const noiseId = loaded.id ?? Identifier.create("direct_noise");
    parsed = new DensityFunction.NoiseFunction(
      Holder.direct(noise, noiseId),
      options.xzScale,
      options.yScale,
      DensityFunction.Constant.ZERO,
      DensityFunction.Constant.ZERO,
      DensityFunction.Constant.ZERO,
    );
  } else {
    parsed = loaded.id
      ? WorldgenRegistries.DENSITY_FUNCTION.getOrThrow(loaded.id)
      : DensityFunction.fromJson(loaded.raw);
  }
  options.mode = options.mode === "auto"
    ? (loaded.kind === "noise" ? "noise" : "density")
    : options.mode;
  const activeReferences = loaded.kind === "density" && loaded.id
    ? new Set([loaded.id.toString()])
    : new Set();
  const density = bindNoise(parsed, options.seed, activeReferences);
  const { png, min, max, surfaceHits } = render(density, options);
  const output = path.resolve(options.output);
  fs.writeFileSync(output, PNG.sync.write(png));
  console.log(`Rendered ${input}`);
  console.log(
    `  mode=${options.mode} size=${options.width}x${options.height} range=${min}..${max}`,
  );
  if (options.mode === "density") {
    const total = options.width * options.height;
    console.log(
      `  surface hits=${surfaceHits}/${total} (${((surfaceHits / total) * 100).toFixed(1)}%)`,
    );
    if (surfaceHits === 0 || surfaceHits === total) {
      console.warn(
        "  warning: this density function does not cross the threshold over the requested Y range; the heightmap uses the requested Y-range boundary.",
      );
    }
  }
  console.log(`  wrote ${output}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
