import { describe, expect, it, vi } from 'vitest';
import { StyleController, type StyleOptions } from './StyleController';

const OPTIONS: StyleOptions = {
  pixelSize: 2,
  pointSizeMode: 'fixed',
  attenuationFactor: 100,
  minPixelSize: 1,
  maxPixelSize: 6,
  colorMode: 'rgb',
  opacity: 1,
  clipMode: 'inside',
};

describe('StyleController', () => {
  it('rejects invalid constructor options', () => {
    expect(() => new StyleController({ ...OPTIONS, opacity: 2 }, () => {})).toThrow(RangeError);
    expect(() => new StyleController({ ...OPTIONS, minPixelSize: 9 }, () => {})).toThrow(RangeError);
  });

  it('requests a render on every mutation', () => {
    const render = vi.fn();
    const ctl = new StyleController(OPTIONS, render);
    ctl.pixelSize = 4;
    ctl.opacity = 0.5;
    ctl.clipPlanes = [];
    expect(render).toHaveBeenCalledTimes(3);
    expect(ctl.style.pixelSize).toBe(4);
    expect(ctl.style.clip.version).toBe(1);
  });

  it('leaves the style untouched when a setter throws', () => {
    const render = vi.fn();
    const ctl = new StyleController(OPTIONS, render);
    expect(() => {
      ctl.opacity = -1;
    }).toThrow(RangeError);
    expect(ctl.opacity).toBe(1);
    expect(render).not.toHaveBeenCalled();
  });

  it('grows the intensity range only while it is unpinned', () => {
    const auto = new StyleController(OPTIONS, () => {});
    auto.growAutoIntensityRange(500);
    expect(auto.intensityRange).toEqual([0, 500]);
    const pinned = new StyleController({ ...OPTIONS, intensityRange: [0, 10] }, () => {});
    pinned.growAutoIntensityRange(500);
    expect(pinned.intensityRange).toEqual([0, 10]);
  });
});
