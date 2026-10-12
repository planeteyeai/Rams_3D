/**
 * AADT from travel speed.
 * Volume = 0.6 × practical + 0.4 × theoretical, then × 24 × 1.1.
 * Practical share of capacity: ≥50 km/h low (25%), 30–50 moderate (65%), below 30 congested (90%).
 * Jam density is set so the Greenshields peak equals lane capacity.
 *
 * Live Google traffic speed is not available without an API key, and a public
 * driving route does not stay on this median. The project figure therefore
 * uses free-flow speed for the 2+2 lane road.
 */

export const AADT_MODEL = {
  lanesPerDirection: 2,
  freeFlowKmh: 80,
  capacityPerLane: 1800,
  practicalWeight: 0.6,
  theoryWeight: 0.4,
  dailyFactor: 24 * 1.1,
}

AADT_MODEL.jamDensityPerLane = (4 * AADT_MODEL.capacityPerLane) / AADT_MODEL.freeFlowKmh

/** Share of directional capacity used at this speed band. */
export function practicalShare(speedKmh) {
  if (speedKmh >= 50) return 0.25
  if (speedKmh >= 30) return 0.65
  return 0.9
}

export function volumeFromSpeed(speedKmh, model = AADT_MODEL) {
  const speed = Math.max(0, speedKmh)
  const lanes = model.lanesPerDirection
  const free = model.freeFlowKmh
  const jam = model.jamDensityPerLane * lanes
  const capacity = model.capacityPerLane * lanes
  const density = speed >= free ? 0 : jam * (1 - speed / free)
  const theoretical = density * speed
  const practical = practicalShare(speed) * capacity
  const hourly = model.practicalWeight * practical + model.theoryWeight * theoretical
  return {
    speedKmh: speed,
    densityPerKm: density,
    theoretical,
    practical,
    hourly,
    aadt: hourly * model.dailyFactor,
    band: speed >= 50 ? 'free-flow' : speed >= 30 ? 'moderate' : 'congested',
  }
}

/** Both directions at the same speed. Default is free-flow on this divided road. */
export function estimateProjectAadt(speedKmh = AADT_MODEL.freeFlowKmh) {
  const increasing = volumeFromSpeed(speedKmh)
  const decreasing = volumeFromSpeed(speedKmh)
  return {
    speedKmh,
    increasing,
    decreasing,
    hourly: increasing.hourly + decreasing.hourly,
    aadt: increasing.aadt + decreasing.aadt,
  }
}
