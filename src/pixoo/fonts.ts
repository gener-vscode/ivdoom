// Copyright (C) 2022 Adam K Dean <adamkdean@googlemail.com>
// Use of this source code is governed by the GPL-3.0
// license that can be found in the LICENSE file.

import Pico from  './fonts/pico8.js';
import Vari from './fonts/vari8.js'
import Arcade from './fonts/arcade7.json' with { type: 'json' };
import Homepun from './fonts/homepun7.json' with { type: 'json' };
import Unlearn from './fonts/unlearn9.json' with { type: 'json' };
import Minecraftory from './fonts/minecraftory10.json' with { type: 'json' };



export interface FontType{
  height: number;
  bitmap: {[key:string]: boolean[]}
}


export const Pico5: FontType = {
  height: 5,
  bitmap: Pico
}

export const Vari5: FontType = {
  height: 5,
  bitmap: Vari
}

export const Arcade7: FontType = {
  height: 9,
  bitmap: Arcade
}

export const Homepun7: FontType = {
  height: 8,
  bitmap: Homepun
}

export const Unlearn9: FontType = {
  height: 12,
  bitmap: Unlearn
}
export const Minecraftory10: FontType = {
  height: 12,
  bitmap: Minecraftory
}

