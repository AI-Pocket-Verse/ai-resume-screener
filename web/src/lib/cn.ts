import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 拼接类名，并让后写的 Tailwind 类覆盖先写的同类（如 px-2 覆盖 px-4）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
