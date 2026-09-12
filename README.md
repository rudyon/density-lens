# density-lens

`density-lens` renders a Minecraft density-function JSON file as a grayscale PNG. It uses [Deepslate](https://github.com/misode/deepslate) for density-function evaluation and supports the noise files found beside the density function in a datapack.

It can also render a raw `worldgen/noise/*.json` file directly. Direct noise files use `--xz-scale 1 --y-scale 1` by default; adjust those values to control coordinate scale.

## Usage

```text
npx density-lens path/to/datapack/data/example_datapack/worldgen/density_function/example.json
```

The default output is `density-lens.png` in the current directory. Density-function files render a terrain-style top-down heightmap: for each X/Z pixel it searches from `--max-y` down to `--min-y` and records the first Y where density is above `--threshold`.

Use `--mode density` for a density heightmap or `--mode noise` for a top-down X/Z noise map at `--y`.

Density heightmaps use a vertical search step of 4 blocks by default, then refine the detected surface. Set `--y-step 1` for exhaustive per-block sampling when thin vertical features matter. Functions that are constant across Y are detected and evaluated without scanning the full height range.

To inspect one horizontal slice instead:

```text
npx density-lens path/to/example.json --mode noise --y 0 --width 512 --height 512 --scale 2 --seed 1234 -o noise.png
```

Render a raw noise definition:

```text
npx density-lens path/to/worldgen/noise/test_noise.json --mode noise --y 0 --xz-scale 0.01 --width 512 --height 512 -o noise.png
```

The seed is used to create deterministic samplers for referenced `worldgen/noise` files. This is the initial evaluator and renderer; matching every detail of Minecraft's `RandomState` wiring is a natural next step for exact parity with a generated world.

Try the included fixture:

```text
node bin/density-lens.mjs examples/gradient.json -o gradient.png
```
