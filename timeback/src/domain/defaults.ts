import type { Category } from './types.ts';

/** Starter categories offered during onboarding; the user edits enjoyment/flexibility to taste. */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'sleep', name: 'Sleep', enjoyment: 'neutral', flexibility: 'essential' },
  { id: 'work', name: 'Work', enjoyment: 'neutral', flexibility: 'fixed' },
  { id: 'commute', name: 'Commute', enjoyment: 'dislikes', flexibility: 'fixed' },
  { id: 'meals', name: 'Meals', enjoyment: 'neutral', flexibility: 'essential' },
  { id: 'chores', name: 'Chores', enjoyment: 'dislikes', flexibility: 'essential' },
  { id: 'exercise', name: 'Exercise', enjoyment: 'loves', flexibility: 'flexible' },
  { id: 'hobby', name: 'Hobbies', enjoyment: 'loves', flexibility: 'flexible' },
  { id: 'social', name: 'Friends & family', enjoyment: 'loves', flexibility: 'flexible' },
  { id: 'scrolling', name: 'Phone / scrolling', enjoyment: 'dislikes', flexibility: 'flexible' },
  { id: 'tv', name: 'TV / streaming', enjoyment: 'neutral', flexibility: 'flexible' },
];
