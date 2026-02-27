import { registerPlugin } from '@capacitor/core'
import type { MobileCronPlugin } from './definitions'

export const MobileCron = registerPlugin<MobileCronPlugin>('MobileCron', {
  web: () => import('./web').then((m) => new m.MobileCronWeb()),
})
