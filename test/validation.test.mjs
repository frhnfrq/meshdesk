import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMessage,resolveLibraryFile,sameLocalOrigin} from '../server/validation.mjs';
const request={text:'The texture looks stretched.',requestId:'12345678-abcd-1234'};
test('restricts local HTTP origin and Host',()=>{assert.equal(sameLocalOrigin({headers:{host:'127.0.0.1:8790',origin:'http://127.0.0.1:8790'}},8790),true);assert.equal(sameLocalOrigin({headers:{host:'127.0.0.1:8790',origin:'https://evil.test'}},8790),false);assert.equal(sameLocalOrigin({headers:{host:'evil.test:8790'}},8790),false);assert.equal(sameLocalOrigin({headers:{host:'127.0.0.1:8790','sec-fetch-site':'cross-site'}},8790),false);});
test('prevents paths outside the asset library',()=>{assert.equal(resolveLibraryFile('/tmp/library','models/alex.fbx'),'/tmp/library/models/alex.fbx');assert.throws(()=>resolveLibraryFile('/tmp/library','../secret'));assert.throws(()=>resolveLibraryFile('/tmp/library','/etc/passwd'));});
test('validates messages, screenshots and camera state',()=>{assert.throws(()=>validateMessage({...request,text:' '}));assert.throws(()=>validateMessage({...request,text:'x'.repeat(12001)}));assert.throws(()=>validateMessage({...request,snapshot:'data:image/jpeg;base64,YWJj'}));assert.throws(()=>validateMessage({...request,snapshot:'file:///etc/passwd'}));const result=validateMessage({...request,view:{camera:[1,2,Infinity],target:[0,1,0],mode:'wire',palette:'Texture 2.png',extra:'ignored'}});assert.deepEqual(result.view,{target:[0,1,0],mode:'wire',palette:'Texture 2.png'});});
test('model references accept only bounded catalog identifiers',()=>{
 assert.deepEqual(validateMessage({...request,modelIds:['123456abcdef','123456abcdef']}).modelIds,['123456abcdef']);
 for(const modelIds of ['123456abcdef',['../secret'],Array(9).fill('123456abcdef'),[null]])assert.throws(()=>validateMessage({...request,modelIds}));
});
