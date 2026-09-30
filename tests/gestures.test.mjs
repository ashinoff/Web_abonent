import test from 'node:test';
import assert from 'node:assert/strict';
import { completedSwipe } from '../public/gestures.js';
test('modal gestures preserve vertical reading, taps and form interactions', () => {
  const base = {dx:0,dy:120,atTop:true,fromHeader:false,canGoBack:false,duration:400};
  assert.equal(completedSwipe(base),'down');
  assert.equal(completedSwipe({...base,atTop:false}),null);
  assert.equal(completedSwipe({...base,atTop:false,fromHeader:true}),'down');
  assert.equal(completedSwipe({...base,dy:8}),null);
  assert.equal(completedSwipe({...base,dy:-120}),null);
  assert.equal(completedSwipe({...base,dx:130}),null);
  assert.equal(completedSwipe({...base,duration:1800}),'down');
  assert.equal(completedSwipe({...base,dx:150,dy:10,atTop:false,canGoBack:true}),'right');
  assert.equal(completedSwipe({...base,dx:150,dy:10,atTop:false}),null);
});
