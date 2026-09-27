import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleProblems, type GuidedRule } from '../web/app/builder/rule-guidance.js';
const states = [{key:'open',type:'initial'},{key:'review',type:'active'},{key:'done',type:'terminal'}];
const rule = (extra: Partial<GuidedRule> = {}): GuidedRule => ({key:'route',from:'review',to:'open',trigger:{on:'manual',by:['owner']},actions:[],...extra});
test('guided manual rule requires explicit authority and complete route', () => {
 assert.deepEqual(ruleProblems(rule(), states, []), []);
 assert.match(ruleProblems(rule({from:'',to:'',trigger:{on:'manual',by:[]}}), states, []).join(' '), /starting status.*next status.*authorized/);
});
test('guide refuses terminal reopening and submission from a working status', () => {
 assert.match(ruleProblems(rule({from:'done'}),states,[]).join(' '), /Finished records/);
 assert.match(ruleProblems(rule({trigger:{on:'submission'}}),states,[]).join(' '), /initial status/);
});
test('guide refuses competing timers, empty references and duplicate routes', () => {
 const timer=rule({trigger:{on:'timer',afterHoursInState:24}});
 assert.match(ruleProblems(timer,states,[timer]).join(' '), /already has a timer/);
 assert.match(ruleProblems(rule({actions:[{do:'send_email',template:''}]}),states,[]).join(' '), /template/);
 assert.match(ruleProblems(rule(),states,[rule()]).join(' '), /already exists/);
});
