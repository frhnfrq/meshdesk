import {forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Sky} from 'three/addons/objects/Sky.js';
import {clone as cloneWithSkeletons} from 'three/addons/utils/SkeletonUtils.js';
import {
  ArrowDownToLine, Box, Boxes, ChevronDown, Copy, Eye, EyeOff, Link2, Maximize, Move3d,
  PanelRight, Plus, Rotate3d, Scale3d, Trash2, TriangleAlert, Unlink2,
} from 'lucide-react';
import Picker from './Picker.jsx';
import '../scene.css';

/* ───────────────────────── Scene data ───────────────────────── */

const LIGHTING_DEFAULTS = {
  sunIntensity: 3, sunColor: '#ffffff', sunAzimuth: 135, sunElevation: 45,
  ambientIntensity: 1, ambientColor: '#dfe8ff', shadows: true, exposure: 1,
};
const ENVIRONMENT_DEFAULTS = {
  type: 'sky', color: '#15171b', topColor: '#6fa8ff', bottomColor: '#e8eef7', imageAssetId: '',
  turbidity: 6, rayleigh: 1.5, showBackground: true, ground: 'grid',
};
const ENVIRONMENT_TYPES = [
  {value: 'sky', label: 'Sky'},
  {value: 'color', label: 'Colour'},
  {value: 'gradient', label: 'Gradient'},
  {value: 'image', label: 'Image'},
];
const GROUND_TYPES = [
  {value: 'grid', label: 'Grid'},
  {value: 'plane', label: 'Plane'},
  {value: 'none', label: 'None'},
];
const MODES = [
  {value: 'translate', label: 'Move', key: 'W', Icon: Move3d},
  {value: 'rotate', label: 'Rotate', key: 'E', Icon: Rotate3d},
  {value: 'scale', label: 'Scale', key: 'R', Icon: Scale3d},
];
const AXES = ['X', 'Y', 'Z'];
const BLOCK_DEFAULTS = {length: 100, width: 20, lanes: 3, laneWidth: 3, theme: '', difficulty: ''};
const ROLE_OPTIONS = [
  {value: '', label: 'None'},
  {value: 'obstacle', label: 'Obstacle'},
  {value: 'pickup', label: 'Pickup'},
  {value: 'decoration', label: 'Decor'},
  {value: 'ground', label: 'Ground'},
];
const DIFFICULTY_OPTIONS = [
  {value: '', label: 'Unset'},
  {value: 'easy', label: 'Easy'},
  {value: 'medium', label: 'Medium'},
  {value: 'hard', label: 'Hard'},
];
/* Lane centres across a block, left to right, as z positions in metres. */
function laneCentres(block) {
  return Array.from({length: block.lanes}, (_, i) => round((i - (block.lanes - 1) / 2) * block.laneWidth, 3));
}

function toNumber(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}
function toColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}
function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
function toOneOf(value, options, fallback) {
  return options.some(option => option.value === value) ? value : fallback;
}
function toVec3(value, fallback) {
  return [0, 1, 2].map(i => toNumber(Array.isArray(value) ? value[i] : undefined, fallback[i]));
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function round(value, digits = 4) {
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded; // avoid -0
}
function sameVec(a, b) {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 1e-6);
}

function normaliseLighting(source) {
  const input = source && typeof source === 'object' ? source : {};
  const d = LIGHTING_DEFAULTS;
  return {
    ...input,
    sunIntensity: Math.max(0, toNumber(input.sunIntensity, d.sunIntensity)),
    sunColor: toColor(input.sunColor, d.sunColor),
    sunAzimuth: toNumber(input.sunAzimuth, d.sunAzimuth),
    sunElevation: clamp(toNumber(input.sunElevation, d.sunElevation), -90, 90),
    ambientIntensity: Math.max(0, toNumber(input.ambientIntensity, d.ambientIntensity)),
    ambientColor: toColor(input.ambientColor, d.ambientColor),
    shadows: toBool(input.shadows, d.shadows),
    exposure: Math.max(0, toNumber(input.exposure, d.exposure)),
  };
}
function normaliseEnvironment(source) {
  const input = source && typeof source === 'object' ? source : {};
  const d = ENVIRONMENT_DEFAULTS;
  return {
    ...input,
    type: toOneOf(input.type, ENVIRONMENT_TYPES, d.type),
    color: toColor(input.color, d.color),
    topColor: toColor(input.topColor, d.topColor),
    bottomColor: toColor(input.bottomColor, d.bottomColor),
    imageAssetId: typeof input.imageAssetId === 'string' ? input.imageAssetId : d.imageAssetId,
    turbidity: Math.max(0, toNumber(input.turbidity, d.turbidity)),
    rayleigh: Math.max(0, toNumber(input.rayleigh, d.rayleigh)),
    showBackground: toBool(input.showBackground, d.showBackground),
    ground: toOneOf(input.ground, GROUND_TYPES, d.ground),
  };
}
function normaliseScene(source) {
  const input = source && typeof source === 'object' ? source : {};
  const seen = new Set();
  const items = (Array.isArray(input.items) ? input.items : [])
    .filter(item => item && typeof item === 'object')
    .map((item, index) => {
      let id = item.id === undefined || item.id === null || item.id === '' ? `item-${index}` : String(item.id);
      if (seen.has(id)) id = `${id}-${index}`;
      seen.add(id);
      return {
        ...item,
        id,
        assetId: item.assetId === undefined || item.assetId === null ? '' : String(item.assetId),
        name: typeof item.name === 'string' && item.name ? item.name : 'Object',
        position: toVec3(item.position, [0, 0, 0]),
        rotation: toVec3(item.rotation, [0, 0, 0]),
        scale: toVec3(item.scale, [1, 1, 1]),
        visible: item.visible !== false,
      };
    });
  return {
    ...input,
    items,
    ...(input.kind === 'block' ? {block: {...BLOCK_DEFAULTS, ...(input.block || {})}} : {}),
    lighting: normaliseLighting(input.lighting),
    environment: normaliseEnvironment(input.environment),
  };
}

function newItemId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function modelUrl(base, assetId, asset, versions = 'current') {
  return `${base}/previews/${encodeURIComponent(assetId)}?version=${versions === 'original' ? 'original' : 'current'}&revision=${asset?.revision || 0}`;
}
function imageUrl(base, assetId) {
  return `${base}/library/${encodeURIComponent(assetId)}`;
}

/* ───────────────────────── three.js engine ───────────────────────── */

const PLACEHOLDER_BOX = new THREE.Box3(new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(0.25, 0.5, 0.25));

function disposeObject(root) {
  if (!root) return;
  const textures = new Set();
  const materials = new Set();
  root.traverse(object => {
    object.geometry?.dispose();
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of list) materials.add(material);
    object.skeleton?.dispose?.();
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    texture.source?.data?.close?.(); // ImageBitmaps created by GLTFLoader
  }
}

function sunDirection(lighting, target) {
  const phi = THREE.MathUtils.degToRad(90 - lighting.sunElevation);
  const theta = THREE.MathUtils.degToRad(lighting.sunAzimuth);
  return target.setFromSphericalCoords(1, phi, theta);
}

function applyTransform(holder, item) {
  holder.position.fromArray(item.position);
  holder.rotation.set(
    THREE.MathUtils.degToRad(item.rotation[0]),
    THREE.MathUtils.degToRad(item.rotation[1]),
    THREE.MathUtils.degToRad(item.rotation[2]),
    'XYZ',
  );
  holder.scale.fromArray(item.scale);
}
function readTransform(holder) {
  return {
    position: holder.position.toArray().map(value => round(value, 4)),
    rotation: [holder.rotation.x, holder.rotation.y, holder.rotation.z].map(value => round(THREE.MathUtils.radToDeg(value), 3)),
    scale: holder.scale.toArray().map(value => round(value, 4)),
  };
}

/* Loaded GLBs are cached per URL and cloned per item, so duplicates and
   re-syncs never download or parse the same model twice. */
function acquireModel(e, url) {
  let record = e.models.get(url);
  if (!record) {
    const created = {refs: 0, template: null, promise: null};
    created.promise = e.loader.loadAsync(url).then(gltf => {
      // Library models carry whatever offset they were authored with. In a scene every model
      // is pivoted at the centre of its base, so position [0,0,0] puts it on the ground at the origin.
      const template = new THREE.Group();
      template.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      if (!box.isEmpty()) {
        const centre = box.getCenter(new THREE.Vector3());
        gltf.scene.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
      }
      if (created.refs <= 0 || !e.alive) {
        disposeObject(template);
        throw new Error('Model released before it finished loading.');
      }
      template.traverse(object => {
        if (object.isMesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      created.template = template;
      return template;
    });
    created.promise.catch(() => {});
    e.models.set(url, created);
    record = created;
  }
  record.refs += 1;
  return record.promise;
}
function releaseModel(e, url) {
  const record = e.models.get(url);
  if (!record) return;
  record.refs -= 1;
  if (record.refs > 0) return;
  e.models.delete(url);
  if (record.template) disposeObject(record.template);
}

function addItemObject(e, id, url) {
  const holder = new THREE.Group();
  holder.userData.itemId = id;
  e.scene.add(holder);
  const entry = {id, url, holder, localBox: new THREE.Box3(), alive: true, ready: false};
  e.items.set(id, entry);
  e.pending += 1;
  e.onStatus(id, 'loading');
  acquireModel(e, url)
    .then(template => {
      if (!entry.alive || !e.alive) return;
      const model = cloneWithSkeletons(template);
      model.updateMatrixWorld(true);
      entry.localBox.setFromObject(model);
      holder.add(model);
      entry.ready = true;
      e.onStatus(id, 'ready');
    })
    .catch(() => {
      if (entry.alive && e.alive) e.onStatus(id, 'error');
    })
    .finally(() => {
      if (!e.alive) return;
      e.pending -= 1;
      e.onModelsSettled();
    });
  return entry;
}
function removeItemObject(e, entry) {
  entry.alive = false;
  if (e.transform.object === entry.holder) e.transform.detach();
  e.scene.remove(entry.holder);
  entry.holder.clear(); // clones share geometry/materials with the cached template
  e.items.delete(entry.id);
  releaseModel(e, entry.url);
  e.onStatus(entry.id, null);
}

function syncItems(e, items, catalogById, base, versions) {
  const wanted = new Set();
  for (const item of items) {
    wanted.add(item.id);
    const url = modelUrl(base, item.assetId, catalogById.get(item.assetId), versions);
    let entry = e.items.get(item.id);
    if (entry && entry.url !== url) {
      removeItemObject(e, entry);
      entry = null;
    }
    if (!entry) entry = addItemObject(e, item.id, url);
    const beingDragged = e.dragging && e.transform.object === entry.holder;
    if (!beingDragged) applyTransform(entry.holder, item);
    entry.holder.visible = item.visible;
  }
  for (const entry of [...e.items.values()]) {
    if (!wanted.has(entry.id)) removeItemObject(e, entry);
  }
}

function sceneBounds(e, box) {
  box.makeEmpty();
  for (const entry of e.items.values()) {
    if (entry.ready && entry.holder.visible) box.expandByObject(entry.holder);
  }
  if (e.blockBox) box.union(e.blockBox);
  return box;
}

/*
 * Draws a block's footprint on the ground: the outline, one line per lane, a green arrow where the
 * track enters and a red one where it leaves. Rebuilt only when the block's size changes.
 */
function syncBlock(e, block) {
  const key = block ? [block.length, block.width, block.lanes, block.laneWidth].join(':') : '';
  if (e.blockKey === key) return;
  const first = e.blockKey === undefined;
  e.blockKey = key;
  if (e.blockGuide) {
    e.scene.remove(e.blockGuide);
    e.blockGuide.traverse(node => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
    e.blockGuide = null;
  }
  e.blockBox = null;
  if (!block) return;
  const group = new THREE.Group();
  const segments = (points, color, opacity = 1) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, 0.02, z)));
    group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color, transparent: opacity < 1, opacity, toneMapped: false})));
  };
  const length = block.length;
  const half = block.width / 2;
  // A dark floor over the footprint, so the block reads against any sky, with a cross line every 10 m.
  const floorGeometry = new THREE.PlaneGeometry(length, block.width);
  floorGeometry.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeometry, new THREE.MeshBasicMaterial({color: 0x14171c, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false}));
  floor.position.set(length / 2, 0.005, 0);
  group.add(floor);
  const ticks = [];
  for (let x = 10; x < length; x += 10) ticks.push([x, -half], [x, half]);
  if (ticks.length) segments(ticks, 0xffffff, 0.12);
  segments([[0, -half], [length, -half], [length, -half], [length, half], [length, half], [0, half], [0, half], [0, -half]], 0xf3b46a);
  segments(laneCentres(block).flatMap(z => [[0, z], [length, z]]), 0x8ab4ff, 0.5);
  const a = Math.max(1, Math.min(3, half * 0.5));
  segments([[-a * 1.6, 0], [0, 0], [-a * 0.7, -a * 0.5], [0, 0], [-a * 0.7, a * 0.5], [0, 0]], 0x5fd08c);
  segments([[length, 0], [length + a * 1.6, 0], [length + a * 0.9, -a * 0.5], [length + a * 1.6, 0], [length + a * 0.9, a * 0.5], [length + a * 1.6, 0]], 0xf2716b);
  e.scene.add(group);
  e.blockGuide = group;
  e.blockBox = new THREE.Box3(new THREE.Vector3(0, 0, -half), new THREE.Vector3(length, 0.1, half));
  // An empty block has nothing else to frame, so show the whole footprint.
  if (first && e.items.size === 0) fitCamera(e);
}

/* Positions the sun and sizes its shadow camera to the current scene bounds. */
function updateSun(e) {
  const lighting = e.lighting;
  const direction = sunDirection(lighting, e.tmpVector);
  const box = sceneBounds(e, e.tmpBox);
  const sphere = e.tmpSphere;
  if (box.isEmpty()) sphere.set(new THREE.Vector3(0, 0, 0), 2);
  else box.getBoundingSphere(sphere);
  const radius = Math.max(sphere.radius, 0.25);

  e.sun.target.position.copy(sphere.center);
  e.sun.target.updateMatrixWorld();
  e.sun.position.copy(sphere.center).addScaledVector(direction, radius * 3);

  const camera = e.sun.shadow.camera;
  camera.left = -radius * 1.25;
  camera.right = radius * 1.25;
  camera.top = radius * 1.25;
  camera.bottom = -radius * 1.25;
  camera.near = radius * 0.5;
  camera.far = radius * 12;
  camera.updateProjectionMatrix();
  e.sun.shadow.normalBias = radius * 0.003;
}

function syncLighting(e, lighting) {
  e.lighting = lighting;
  e.sun.color.set(lighting.sunColor);
  e.sun.intensity = lighting.sunElevation > 0 ? lighting.sunIntensity : 0;
  e.sun.castShadow = lighting.shadows;
  e.hemisphere.color.set(lighting.ambientColor);
  e.hemisphere.groundColor.set(lighting.ambientColor).multiplyScalar(0.35);
  e.hemisphere.intensity = lighting.ambientIntensity;
  e.renderer.toneMappingExposure = lighting.exposure;
  updateSun(e);
}

function syncGround(e, environment, lighting) {
  e.grid.visible = environment.ground === 'grid';
  e.groundPlane.visible = environment.ground === 'plane';
  e.shadowCatcher.visible = environment.ground === 'grid' && lighting.shadows;
}

function disposeEnvironment(e) {
  e.scene.environment = null;
  e.envTarget?.dispose();
  e.envTarget = null;
  e.envBackground?.dispose();
  e.envBackground = null;
}
function applyBackground(e) {
  const environment = e.environment;
  e.backgroundColor.set(environment.color);
  e.sky.visible = environment.type === 'sky' && environment.showBackground;
  e.scene.background = environment.showBackground && e.envBackground ? e.envBackground : e.backgroundColor;
}
function gradientCanvas(topColor, bottomColor) {
  // 2:1 so it also works as an equirectangular map (PMREM sizes its cube from the width).
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, bottomColor);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function syncEnvironment(e, environment, lighting, base) {
  e.environment = environment;
  let key = 'color';
  if (environment.type === 'sky') {
    key = ['sky', environment.turbidity, environment.rayleigh, lighting.sunAzimuth, lighting.sunElevation].join('|');
  } else if (environment.type === 'gradient') {
    key = ['gradient', environment.topColor, environment.bottomColor].join('|');
  } else if (environment.type === 'image' && environment.imageAssetId) {
    key = ['image', base, environment.imageAssetId].join('|');
  }

  if (key !== e.envKey) {
    e.envKey = key;
    disposeEnvironment(e);
    e.onEnvironmentStatus('');

    if (environment.type === 'sky') {
      const uniforms = e.sky.material.uniforms;
      uniforms.turbidity.value = environment.turbidity;
      uniforms.rayleigh.value = environment.rayleigh;
      uniforms.mieCoefficient.value = 0.005;
      uniforms.mieDirectionalG.value = 0.8;
      sunDirection(lighting, uniforms.sunPosition.value);
      // Bake the procedural sky into a PMREM for image-based lighting.
      e.sky.visible = true;
      e.envScene.add(e.sky);
      e.envTarget = e.pmrem.fromScene(e.envScene);
      e.scene.add(e.sky);
      e.scene.environment = e.envTarget.texture;
    } else if (environment.type === 'gradient') {
      const canvas = gradientCanvas(environment.topColor, environment.bottomColor);
      // Screen-space texture for the backdrop, equirect copy for lighting.
      const background = new THREE.CanvasTexture(canvas);
      background.colorSpace = THREE.SRGBColorSpace;
      const equirect = new THREE.CanvasTexture(canvas);
      equirect.colorSpace = THREE.SRGBColorSpace;
      equirect.mapping = THREE.EquirectangularReflectionMapping;
      e.envTarget = e.pmrem.fromEquirectangular(equirect);
      equirect.dispose();
      e.envBackground = background;
      e.scene.environment = e.envTarget.texture;
    } else if (key !== 'color') {
      e.onEnvironmentStatus('loading');
      e.textureLoader.load(
        imageUrl(base, environment.imageAssetId),
        texture => {
          if (!e.alive || e.envKey !== key) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.mapping = THREE.EquirectangularReflectionMapping;
          e.envTarget = e.pmrem.fromEquirectangular(texture);
          e.envBackground = texture;
          e.scene.environment = e.envTarget.texture;
          e.onEnvironmentStatus('');
          applyBackground(e);
        },
        undefined,
        () => {
          if (e.alive && e.envKey === key) e.onEnvironmentStatus('error');
        },
      );
    }
  }
  applyBackground(e);
}

function fitCamera(e) {
  const box = sceneBounds(e, e.tmpBox);
  const sphere = e.tmpSphere;
  if (box.isEmpty()) sphere.set(new THREE.Vector3(0, 0.5, 0), 2.5);
  else box.getBoundingSphere(sphere);
  const radius = Math.max(sphere.radius, 0.05);

  const {camera, orbit} = e;
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.1;

  const direction = camera.position.clone().sub(orbit.target);
  if (direction.lengthSq() < 1e-8) direction.set(0.6, 0.45, 0.8);
  direction.normalize();

  orbit.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = clamp(distance / 500, 0.01, 0.25);
  camera.far = Math.max(1000, distance * 50);
  camera.updateProjectionMatrix();
  orbit.maxDistance = Math.max(500, distance * 20);
  orbit.update();
}

/* The Sky addon is tuned for a tone-mapping exposure of about 0.5. Scale its
   output instead, so the scene's own exposure setting stays meaningful and the
   sky-derived environment lighting is not blown out. */
const SKY_INTENSITY = 0.2;
function dimSky(sky) {
  const material = sky.material;
  const output = 'gl_FragColor = vec4( retColor, 1.0 );';
  if (!material.fragmentShader.includes(output)) return;
  material.uniforms.skyIntensity = {value: SKY_INTENSITY};
  material.fragmentShader = 'uniform float skyIntensity;\n' + material.fragmentShader.replace(output, 'gl_FragColor = vec4( retColor * skyIntensity, 1.0 );');
  material.needsUpdate = true;
}

function createEngine(host) {
  const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D scene');
  host.append(renderer.domElement);

  const accentValue = getComputedStyle(host).getPropertyValue('--accent').trim();
  const accent = new THREE.Color(/^#[0-9a-f]{3,8}$/i.test(accentValue) ? accentValue : '#f3b46a');

  const scene = new THREE.Scene();
  const backgroundColor = new THREE.Color(ENVIRONMENT_DEFAULTS.color);
  scene.background = backgroundColor;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  camera.position.set(6, 4.5, 8);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.minDistance = 0.05;
  orbit.maxDistance = 500;
  orbit.target.set(0, 0.5, 0);
  orbit.update();

  const transform = new TransformControls(camera, renderer.domElement);
  const transformHelper = transform.getHelper();
  scene.add(transformHelper);

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  const sky = new Sky();
  sky.scale.setScalar(450000);
  dimSky(sky);
  sky.visible = false;
  scene.add(sky);

  const grid = new THREE.GridHelper(40, 40, 0x474d58, 0x25282e); // 1 m cells
  scene.add(grid);

  const groundGeometry = new THREE.PlaneGeometry(400, 400);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPlane = new THREE.Mesh(groundGeometry, new THREE.MeshStandardMaterial({color: 0x8c8f96, roughness: 1, metalness: 0}));
  groundPlane.position.y = -0.001;
  groundPlane.receiveShadow = true;
  groundPlane.visible = false;
  scene.add(groundPlane);

  // Lets shadows land on the grid without drawing a solid floor.
  const shadowCatcher = new THREE.Mesh(groundGeometry, new THREE.ShadowMaterial({opacity: 0.35}));
  shadowCatcher.position.y = -0.001;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  const selectionBox = new THREE.Box3();
  const selectionOutline = new THREE.Box3Helper(selectionBox, accent);
  selectionOutline.material.toneMapped = false;
  const selection = new THREE.Group();
  selection.matrixAutoUpdate = false;
  selection.visible = false;
  selection.add(selectionOutline);
  scene.add(selection);

  return {
    alive: true,
    renderer, scene, camera, orbit, transform, transformHelper,
    hemisphere, sun, sky, grid, groundPlane, shadowCatcher, groundGeometry,
    selection, selectionBox, selectionOutline,
    backgroundColor,
    envScene: new THREE.Scene(),
    pmrem: new THREE.PMREMGenerator(renderer),
    envKey: null, envTarget: null, envBackground: null,
    loader: new GLTFLoader(),
    textureLoader: new THREE.TextureLoader(),
    items: new Map(), // item id → {id, url, holder, localBox, alive, ready}
    models: new Map(), // model url → {refs, template, promise}
    pending: 0,
    autoFit: true,
    dragging: false,
    selectedId: null,
    lighting: normaliseLighting(),
    environment: normaliseEnvironment(),
    tmpBox: new THREE.Box3(), tmpSphere: new THREE.Sphere(), tmpVector: new THREE.Vector3(),
    onStatus() {}, onEnvironmentStatus() {}, onModelsSettled() {},
  };
}

function renderFrame(e) {
  const entry = e.selectedId ? e.items.get(e.selectedId) : null;
  if (entry && entry.holder.visible && !e.hideOverlays) {
    entry.holder.updateMatrixWorld();
    e.selectionBox.copy(entry.ready && !entry.localBox.isEmpty() ? entry.localBox : PLACEHOLDER_BOX);
    e.selection.matrix.copy(entry.holder.matrixWorld);
    e.selection.matrixWorldNeedsUpdate = true;
    e.selection.visible = true;
  } else {
    e.selection.visible = false;
  }
  e.renderer.render(e.scene, e.camera);
}

function destroyEngine(e) {
  e.alive = false;
  e.renderer.setAnimationLoop(null);
  e.transform.detach();
  e.transform.dispose();
  e.orbit.dispose();
  for (const entry of e.items.values()) {
    entry.alive = false;
    entry.holder.clear();
  }
  e.items.clear();
  for (const record of e.models.values()) {
    record.refs = 0;
    if (record.template) disposeObject(record.template);
  }
  e.models.clear();
  disposeEnvironment(e);
  e.pmrem.dispose();
  e.sky.geometry.dispose();
  e.sky.material.dispose();
  e.grid.geometry.dispose();
  e.grid.material.dispose();
  e.groundGeometry.dispose();
  e.groundPlane.material.dispose();
  e.shadowCatcher.material.dispose();
  e.selectionOutline.geometry.dispose();
  e.selectionOutline.material.dispose();
  e.sun.shadow.map?.dispose();
  e.sun.dispose();
  e.hemisphere.dispose();
  e.renderer.dispose();
  e.renderer.forceContextLoss();
  e.renderer.domElement.remove();
}

/* ───────────────────────── Panel controls ───────────────────────── */

function NumberField({label, value, onCommit, step = 0.1, min, max}) {
  // `text` is only set while the user is typing so partial input ("-", "1.") survives.
  const [text, setText] = useState(null);
  const shown = text === null ? String(round(value, 4)) : text;
  return (
    <input
      className="scene-num"
      type="number"
      aria-label={label}
      value={shown}
      step={step}
      min={min}
      max={max}
      onChange={event => {
        setText(event.target.value);
        const parsed = parseFloat(event.target.value);
        if (!Number.isFinite(parsed)) return;
        const next = clamp(parsed, min ?? -Infinity, max ?? Infinity);
        if (next !== value) onCommit(next);
      }}
      onBlur={() => setText(null)}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function VectorRow({label, value, step, onAxisChange, children}) {
  return (
    <div className="scene-vector">
      <div className="scene-vector-label">
        <span>{label}</span>
        {children}
      </div>
      <div className="scene-vector-fields">
        {AXES.map((axis, index) => (
          <label key={axis} className="scene-axis" data-axis={axis}>
            <span aria-hidden="true">{axis}</span>
            <NumberField label={`${label} ${axis}`} value={value[index]} step={step} onCommit={next => onAxisChange(index, next)} />
          </label>
        ))}
      </div>
    </div>
  );
}

function SliderRow({label, value, min, max, step, onChange}) {
  return (
    <div className="scene-row">
      <span className="scene-row-label">{label}</span>
      <input
        className="scene-range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={clamp(value, min, max)}
        onChange={event => onChange(Number(event.target.value))}
      />
      <NumberField label={`${label} value`} value={value} min={min} max={max} step={step} onCommit={onChange} />
    </div>
  );
}

function ColorRow({label, value, onChange}) {
  return (
    <label className="scene-row">
      <span className="scene-row-label">{label}</span>
      <span className="scene-color">
        <input type="color" aria-label={label} value={value} onChange={event => onChange(event.target.value)} />
        <code>{value}</code>
      </span>
    </label>
  );
}

function ToggleRow({label, checked, onChange}) {
  return (
    <label className="scene-row scene-toggle">
      <span className="scene-row-label">{label}</span>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  );
}

function Segmented({label, options, value, onChange}) {
  return (
    <div className="scene-seg" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Section({title, count, open, onToggle, hidden, children}) {
  if (hidden) return null;
  return (
    <section className="scene-section">
      <button type="button" className="scene-section-head" aria-expanded={open} onClick={onToggle}>
        <ChevronDown size={14} />
        <strong>{title}</strong>
        {count !== undefined && <span className="scene-count">{count}</span>}
      </button>
      {open && <div className="scene-section-body">{children}</div>}
    </section>
  );
}

/* ───────────────────────── Component ───────────────────────── */

const SceneView = forwardRef(function SceneView({base = '', scene, catalog, onChange, onOpenModel, dockPanel = false, panelHost = null, onShowPanel, versions = 'current'}, ref) {
  const rootRef = useRef(null);
  const hostRef = useRef(null);
  const engineRef = useRef(null);
  const actionsRef = useRef({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // `draft` is the scene we render. It follows the `scene` prop and is updated
  // optimistically on user edits, so the view never waits on the parent.
  const [draft, setDraft] = useState(() => normaliseScene(scene));
  const draftRef = useRef(draft);
  const lastSceneProp = useRef(scene);

  const [selectedId, setSelectedId] = useState(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const [mode, setMode] = useState('translate');
  const [panelOpen, setPanelOpen] = useState(true);
  const [sections, setSections] = useState({block: true, objects: true, lighting: true, environment: true});
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [uniformScale, setUniformScale] = useState(true);
  const [statuses, setStatuses] = useState({});
  const [environmentStatus, setEnvironmentStatus] = useState('');
  const [live, setLive] = useState(null); // transform of the item being dragged
  const [webglError, setWebglError] = useState('');

  const assets = Array.isArray(catalog) ? catalog : [];
  const catalogById = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [catalog]);
  const models = useMemo(() => assets.filter(asset => asset.type === 'model' && !asset.removed), [catalog]);
  const images = useMemo(
    () => assets.filter(asset => (asset.type === 'texture' || asset.type === 'reference') && !asset.removed),
    [catalog],
  );

  /* ── Prop → draft (never calls onChange) ── */
  useEffect(() => {
    if (lastSceneProp.current === scene) return;
    lastSceneProp.current = scene;
    const next = normaliseScene(scene);
    draftRef.current = next;
    setDraft(next);
  }, [scene]);

  /* ── User edits ── */
  function emit(next) {
    draftRef.current = next;
    setDraft(next);
    onChangeRef.current?.(next);
  }
  function updateItem(id, patch) {
    const current = draftRef.current;
    if (!current.items.some(item => item.id === id)) return;
    emit({...current, items: current.items.map(item => (item.id === id ? {...item, ...patch} : item))});
  }
  function removeItem(id) {
    const current = draftRef.current;
    if (!current.items.some(item => item.id === id)) return;
    emit({...current, items: current.items.filter(item => item.id !== id)});
    if (selectedRef.current === id) setSelectedId(null);
  }
  function duplicateItem(id) {
    const current = draftRef.current;
    const source = current.items.find(item => item.id === id);
    if (!source) return;
    // Offset the copy by the object's width so it doesn't hide inside the original.
    let offset = 1;
    const entry = engineRef.current?.items.get(id);
    if (entry?.ready) {
      const size = new THREE.Box3().setFromObject(entry.holder).getSize(new THREE.Vector3());
      if (Number.isFinite(size.x) && size.x > 0) offset = size.x * 1.1;
    }
    const copy = {
      ...source,
      id: newItemId(),
      name: /\bcopy$/i.test(source.name) ? source.name : `${source.name} copy`,
      position: [round(source.position[0] + offset), source.position[1], source.position[2]],
      rotation: [...source.rotation],
      scale: [...source.scale],
    };
    emit({...current, items: [...current.items, copy]});
    setSelectedId(copy.id);
  }
  function addModel(asset, position = [0, 0, 0]) {
    const current = draftRef.current;
    const item = {
      id: newItemId(),
      assetId: asset.id,
      name: asset.name || 'Object',
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    };
    emit({...current, items: [...current.items, item]});
    setSelectedId(item.id);
    setAddOpen(false);
    setQuery('');
  }
  /* A model dragged in from the library lands where the pointer meets the ground. */
  const DRAG_TYPE = 'application/x-meshdesk-model';
  const [dropActive, setDropActive] = useState(false);
  function onDragOver(event) {
    if (![...event.dataTransfer.types].includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  }
  function onDrop(event) {
    setDropActive(false);
    const asset = catalogById.get(event.dataTransfer.getData(DRAG_TYPE));
    if (!asset || asset.type !== 'model' || asset.removed) return;
    event.preventDefault();
    const e = engineRef.current;
    let position = [0, 0, 0];
    if (e && hostRef.current) {
      const rect = hostRef.current.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), e.camera);
      const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (hit && hit.length() < 2000) position = [Math.round(hit.x * 100) / 100, 0, Math.round(hit.z * 100) / 100];
    }
    addModel(asset, position);
  }
  function dropToGround(id) {
    const item = draftRef.current.items.find(candidate => candidate.id === id);
    const entry = engineRef.current?.items.get(id);
    if (!item || !entry?.ready) return;
    entry.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(entry.holder, true);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return;
    const y = round(item.position[1] - box.min.y);
    if (y !== item.position[1]) updateItem(id, {position: [item.position[0], y, item.position[2]]});
  }
  function setAxis(id, field, index, value) {
    const item = draftRef.current.items.find(candidate => candidate.id === id);
    if (!item) return;
    const next = [...item[field]];
    if (field === 'scale') {
      const safe = value === 0 ? 0.001 : value;
      const previous = item.scale[index];
      if (uniformScale) {
        const ratio = previous !== 0 ? safe / previous : null;
        for (let i = 0; i < 3; i += 1) next[i] = ratio === null ? safe : round(item.scale[i] * ratio);
      }
      next[index] = safe;
    } else {
      next[index] = value;
    }
    updateItem(id, {[field]: next});
  }
  function setBlock(patch) {
    const current = draftRef.current;
    emit({...current, block: {...current.block, ...patch}});
  }
  function setLighting(patch) {
    const current = draftRef.current;
    emit({...current, lighting: {...current.lighting, ...patch}});
  }
  function setEnvironment(patch) {
    const current = draftRef.current;
    emit({...current, environment: {...current.environment, ...patch}});
  }
  function fit() {
    if (engineRef.current) fitCamera(engineRef.current);
  }
  function previewTransform() {
    const e = engineRef.current;
    const entry = e?.items.get(e.selectedId);
    if (entry) setLive({id: entry.id, ...readTransform(entry.holder)});
  }
  function commitTransform() {
    const e = engineRef.current;
    setLive(null);
    if (!e) return;
    const entry = e.items.get(e.selectedId);
    const item = entry && draftRef.current.items.find(candidate => candidate.id === entry.id);
    if (!item) return;
    const next = readTransform(entry.holder);
    const changed = !sameVec(next.position, item.position) || !sameVec(next.rotation, item.rotation) || !sameVec(next.scale, item.scale);
    if (changed) updateItem(item.id, next);
    else applyTransform(entry.holder, item);
  }
  function openAdd() {
    setPanelOpen(true);
    onShowPanel?.();
    setSections(current => ({...current, objects: true}));
    setAddOpen(true);
  }
  actionsRef.current = {removeItem, duplicateItem, fit, previewTransform, commitTransform, setSelectedId, setMode};

  /* ── Engine lifetime ── */
  useEffect(() => {
    const host = hostRef.current;
    let e;
    try {
      e = createEngine(host);
    } catch {
      setWebglError('WebGL unavailable. Enable hardware acceleration in your browser.');
      return undefined;
    }
    engineRef.current = e;
    setWebglError('');
    const {renderer, camera, orbit, transform} = e;
    const canvas = renderer.domElement;

    e.onStatus = (id, status) => {
      setStatuses(current => {
        if (status === null) {
          if (!(id in current)) return current;
          const next = {...current};
          delete next[id];
          return next;
        }
        return current[id] === status ? current : {...current, [id]: status};
      });
    };
    e.onEnvironmentStatus = status => setEnvironmentStatus(status);
    e.onModelsSettled = () => {
      updateSun(e);
      if (e.pending === 0 && e.autoFit && [...e.items.values()].some(entry => entry.ready)) {
        e.autoFit = false;
        fitCamera(e);
      }
    };

    const onDraggingChanged = event => {
      e.dragging = event.value;
      orbit.enabled = !event.value;
      if (!event.value) {
        actionsRef.current.commitTransform();
        updateSun(e);
      }
    };
    const onObjectChange = () => actionsRef.current.previewTransform();
    transform.addEventListener('dragging-changed', onDraggingChanged);
    transform.addEventListener('objectChange', onObjectChange);

    // Click (not drag) selects the object under the pointer, or clears the selection.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerStart = null;
    const onPointerDown = event => {
      rootRef.current?.focus({preventScroll: true});
      const onGizmo = e.dragging || (transform.object && transform.axis !== null);
      pointerStart = event.button === 0 && !onGizmo ? [event.clientX, event.clientY] : null;
    };
    const onPointerUp = event => {
      const start = pointerStart;
      pointerStart = null;
      if (!start || event.button !== 0 || e.dragging) return;
      if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const holders = [...e.items.values()].filter(entry => entry.holder.visible).map(entry => entry.holder);
      const hit = raycaster.intersectObjects(holders, true)[0];
      let id = null;
      for (let object = hit?.object; object; object = object.parent) {
        if (object.userData.itemId) {
          id = object.userData.itemId;
          break;
        }
      }
      actionsRef.current.setSelectedId(id);
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);

    const onKeyDown = event => {
      const root = rootRef.current;
      const target = event.target;
      if (!root || event.defaultPrevented) return;
      if (target instanceof Element) {
        if (target !== document.body && !root.contains(target)) return;
        if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if (target.closest('[role=combobox],[role=listbox]')) return;
      }
      const actions = actionsRef.current;
      const selected = selectedRef.current;
      const key = String(event.key || '').toLowerCase();
      if (event.metaKey || event.ctrlKey) {
        if (key === 'd' && !event.shiftKey && !event.altKey && selected) {
          event.preventDefault();
          actions.duplicateItem(selected);
        }
        return;
      }
      if (event.altKey) return;
      if (key === 'w') actions.setMode('translate');
      else if (key === 'e') actions.setMode('rotate');
      else if (key === 'r') actions.setMode('scale');
      else if (key === 'f') actions.fit();
      else if (key === 'escape' && selected && !e.dragging) actions.setSelectedId(null);
      else if ((key === 'delete' || key === 'backspace') && selected && !e.dragging) {
        event.preventDefault();
        actions.removeItem(selected);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    const resize = () => {
      const {clientWidth: width, clientHeight: height} = host;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    renderer.setAnimationLoop(() => {
      orbit.update();
      renderFrame(e);
    });

    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      transform.removeEventListener('dragging-changed', onDraggingChanged);
      transform.removeEventListener('objectChange', onObjectChange);
      destroyEngine(e);
      engineRef.current = null;
    };
  }, []);

  /* ── Reconcile the three.js scene with the draft ── */
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    syncItems(e, draft.items, catalogById, base, versions);
    syncLighting(e, draft.lighting);
    syncEnvironment(e, draft.environment, draft.lighting, base);
    syncGround(e, draft.environment, draft.lighting);
    syncBlock(e, draft.kind === 'block' ? draft.block : null);
    if (draft.kind === 'block') e.grid.visible = false; // the footprint has its own floor and lines

    const item = draft.items.find(candidate => candidate.id === selectedId);
    const entry = item ? e.items.get(item.id) : null;
    e.selectedId = item ? item.id : null;
    if (entry && item.visible) {
      if (e.transform.object !== entry.holder) e.transform.attach(entry.holder);
    } else if (e.transform.object) {
      e.transform.detach();
    }
    e.transform.setMode(mode);
    if (selectedId && !item) setSelectedId(null);
  }, [draft, catalogById, base, selectedId, mode, versions]);

  /* ── Imperative API ── */
  useImperativeHandle(ref, () => ({
    fit() {
      if (engineRef.current) fitCamera(engineRef.current);
    },
    capture() {
      const e = engineRef.current;
      if (!e) throw new Error('The scene view is not ready.');
      // Render a clean frame without the gizmo or selection outline.
      const helperVisible = e.transformHelper.visible;
      e.transformHelper.visible = false;
      e.hideOverlays = true;
      let snapshot;
      try {
        renderFrame(e);
        const source = e.renderer.domElement;
        const image = document.createElement('canvas');
        const scale = Math.min(1, 1280 / Math.max(source.width, 1));
        image.width = Math.max(1, Math.round(source.width * scale));
        image.height = Math.max(1, Math.round(source.height * scale));
        image.getContext('2d').drawImage(source, 0, 0, image.width, image.height);
        snapshot = image.toDataURL('image/jpeg', 0.86);
      } finally {
        e.transformHelper.visible = helperVisible;
        e.hideOverlays = false;
      }
      return {snapshot, view: {camera: e.camera.position.toArray(), target: e.orbit.target.toArray()}};
    },
  }), []);

  /* ── Render ── */
  const {items, lighting, environment} = draft;
  const isBlock = draft.kind === 'block';
  const block = isBlock ? draft.block : null;
  const lanes = block ? laneCentres(block) : [];
  const outside = block
    ? items.filter(item => item.visible && (item.position[0] < -0.01 || item.position[0] > block.length + 0.01 || Math.abs(item.position[2]) > block.width / 2 + 0.01))
    : [];
  const selected = items.find(item => item.id === selectedId) || null;
  const shownTransform = selected && live?.id === selected.id ? live : selected;
  const loadingCount = items.filter(item => statuses[item.id] === 'loading').length;
  const search = query.trim().toLowerCase();
  const filteredModels = search ? models.filter(asset => String(asset.name || '').toLowerCase().includes(search)) : models;
  const imageOptions = [{value: '', label: 'Choose an image…'}, ...images.map(asset => ({value: asset.id, label: asset.name || asset.id}))];
  const imageValue = images.some(asset => asset.id === environment.imageAssetId) ? environment.imageAssetId : '';
  const toggleSection = name => setSections(current => ({...current, [name]: !current[name]}));

  return (
    <div className="scene-root" ref={rootRef} tabIndex={-1}>
      <div className={'scene-viewport' + (dropActive ? ' scene-drop' : '')} onDragOver={onDragOver} onDragLeave={() => setDropActive(false)} onDrop={onDrop}>
        <div className="scene-canvas" ref={hostRef} />

        {webglError && <div className="scene-overlay scene-error" role="alert">{webglError}</div>}

        {!webglError && items.length === 0 && (
          <div className="scene-empty">
            <Boxes size={26} strokeWidth={1.5} />
            <strong>{isBlock ? 'This block is empty' : 'This scene is empty'}</strong>
            <p>{isBlock ? 'Add models from the library and place them inside the outlined footprint, or ask the agent to lay the block out.' : 'Add a model from the library, or ask the agent to build the scene for you.'}</p>
            <button type="button" onClick={openAdd}><Plus size={14} />Add model</button>
          </div>
        )}

        {loadingCount > 0 && (
          <div className="scene-status" role="status">
            <span className="spinner" />
            Loading {loadingCount} {loadingCount === 1 ? 'model' : 'models'}…
          </div>
        )}

        {!webglError && (
          <div className="toolbar scene-toolbar" role="toolbar" aria-label="Scene tools">
            {MODES.map(({value, label, key, Icon}) => (
              <button
                key={value}
                type="button"
                className="tool-icon"
                aria-label={label}
                aria-pressed={mode === value}
                data-tip={`${label} (${key})`}
                onClick={() => setMode(value)}
              >
                <Icon size={16} />
              </button>
            ))}
            <span className="scene-sep" aria-hidden="true" />
            <button type="button" className="tool-icon" aria-label="Fit scene to view" data-tip="Fit scene (F)" onClick={fit}>
              <Maximize size={16} />
            </button>
            {!dockPanel && <button
              type="button"
              className="tool-icon"
              aria-label="Scene settings panel"
              aria-pressed={panelOpen}
              data-tip={panelOpen ? 'Hide panel' : 'Show panel'}
              onClick={() => setPanelOpen(open => !open)}
            >
              <PanelRight size={16} />
            </button>}
          </div>
        )}
      </div>

      {(() => {
        const panel = (
        <aside className="scene-panel" aria-label="Scene settings">
          <Section title="Block" hidden={!isBlock} open={sections.block} onToggle={() => toggleSection('block')}>
            {isBlock && (
              <>
                <div className="scene-block-grid">
                  <label>Length<span><NumberField label="Block length in metres" value={block.length} step={1} min={1} max={2000} onCommit={value => setBlock({length: value})} /><em>m</em></span></label>
                  <label>Width<span><NumberField label="Block width in metres" value={block.width} step={1} min={1} max={500} onCommit={value => setBlock({width: value})} /><em>m</em></span></label>
                  <label>Lanes<span><NumberField label="Number of lanes" value={block.lanes} step={1} min={1} max={9} onCommit={value => setBlock({lanes: Math.round(value)})} /></span></label>
                  <label>Lane width<span><NumberField label="Lane width in metres" value={block.laneWidth} step={0.5} min={0.5} max={50} onCommit={value => setBlock({laneWidth: value})} /><em>m</em></span></label>
                </div>
                <label className="scene-row scene-block-theme">
                  <span className="scene-row-label">Theme</span>
                  <input type="text" aria-label="Block theme" maxLength={60} placeholder="village, station…" value={block.theme} onChange={event => setBlock({theme: event.target.value})} />
                </label>
                <Segmented label="Difficulty" options={DIFFICULTY_OPTIONS} value={block.difficulty} onChange={value => setBlock({difficulty: value})} />
                <p className="scene-hint">The track enters at the green arrow (x = 0) and leaves at the red one (x = {round(block.length, 2)}). Blue lines are the lane centres.</p>
                {outside.length > 0 && (
                  <p className="scene-hint scene-hint-error">
                    Outside the footprint: {outside.slice(0, 4).map(item => item.name).join(', ')}{outside.length > 4 ? ` and ${outside.length - 4} more` : ''}.
                  </p>
                )}
              </>
            )}
          </Section>

          <Section title="Objects" count={items.length} open={sections.objects} onToggle={() => toggleSection('objects')}>
            {items.length > 0 && (
              <ul className="scene-items">
                {items.map(item => {
                  const asset = catalogById.get(item.assetId);
                  const missing = assets.length > 0 && (!asset || asset.removed);
                  const failed = statuses[item.id] === 'error';
                  return (
                    <li key={item.id} className={'scene-item' + (item.id === selectedId ? ' selected' : '') + (item.visible ? '' : ' hidden')}>
                      <button
                        type="button"
                        className="scene-item-main"
                        aria-pressed={item.id === selectedId}
                        onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                      >
                        <Box size={14} />
                        <span className="scene-item-name">{item.name}</span>
                        {statuses[item.id] === 'loading' && <span className="spinner scene-item-spinner" />}
                        {(failed || missing) && (
                          <span className="scene-item-warn" title={missing ? 'This model is no longer in the library.' : 'The model could not be loaded.'}>
                            <TriangleAlert size={13} />
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="scene-icon"
                        aria-label={item.visible ? `Hide ${item.name}` : `Show ${item.name}`}
                        aria-pressed={!item.visible}
                        onClick={() => updateItem(item.id, {visible: !item.visible})}
                      >
                        {item.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                      <button type="button" className="scene-icon scene-danger" aria-label={`Remove ${item.name}`} onClick={() => removeItem(item.id)}>
                        <Trash2 size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <button type="button" className="scene-add" aria-expanded={addOpen} onClick={() => setAddOpen(open => !open)}>
              <Plus size={14} />Add model
            </button>
            {addOpen && (
              <div className="scene-add-list">
                <input
                  type="search"
                  className="scene-search"
                  placeholder="Search models"
                  aria-label="Search models"
                  autoFocus
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') setAddOpen(false);
                    if (event.key === 'Enter' && filteredModels.length > 0) addModel(filteredModels[0]);
                  }}
                />
                {filteredModels.length > 0 ? (
                  <ul>
                    {filteredModels.map(asset => (
                      <li key={asset.id}>
                        <button type="button" onClick={() => addModel(asset)}>
                          <Box size={14} />
                          <span>{asset.name || asset.id}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="scene-hint">{models.length === 0 ? 'No models in the library yet.' : 'No models match that search.'}</p>
                )}
              </div>
            )}

            {selected && shownTransform && (
              <div className="scene-transform">
                <div className="scene-subhead">{selected.name}</div>
                <VectorRow label="Position" value={shownTransform.position} step={0.1} onAxisChange={(index, value) => setAxis(selected.id, 'position', index, value)} />
                <VectorRow label="Rotation" value={shownTransform.rotation} step={5} onAxisChange={(index, value) => setAxis(selected.id, 'rotation', index, value)} />
                <VectorRow label="Scale" value={shownTransform.scale} step={0.1} onAxisChange={(index, value) => setAxis(selected.id, 'scale', index, value)}>
                  <button
                    type="button"
                    className="scene-icon"
                    aria-label="Uniform scale"
                    aria-pressed={uniformScale}
                    title={uniformScale ? 'Uniform scale is on' : 'Uniform scale is off'}
                    onClick={() => setUniformScale(locked => !locked)}
                  >
                    {uniformScale ? <Link2 size={13} /> : <Unlink2 size={13} />}
                  </button>
                </VectorRow>
                {isBlock && (
                  <>
                    <div className="scene-vector-label"><span>Role in the game</span></div>
                    <Segmented label="Role" options={ROLE_OPTIONS} value={selected.role || ''} onChange={value => updateItem(selected.id, {role: value})} />
                    <div className="scene-vector-label"><span>Snap to lane</span></div>
                    <div className="scene-lanes">
                      {lanes.map((z, index) => (
                        <button
                          type="button"
                          key={index}
                          aria-label={`Move to lane ${index + 1}`}
                          aria-pressed={Math.abs(shownTransform.position[2] - z) < 0.01}
                          onClick={() => setAxis(selected.id, 'position', 2, z)}
                        >
                          {index + 1}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="scene-actions">
                  {onOpenModel && catalogById.has(selected.assetId) && (
                    <button type="button" title="Open this model on its own, to review or restyle it" onClick={() => onOpenModel(selected.assetId)}><Box size={13} />Open model</button>
                  )}
                  <button type="button" onClick={() => duplicateItem(selected.id)}><Copy size={13} />Duplicate</button>
                  <button type="button" disabled={statuses[selected.id] !== 'ready'} onClick={() => dropToGround(selected.id)}>
                    <ArrowDownToLine size={13} />Drop to ground
                  </button>
                </div>
              </div>
            )}
            {!selected && items.length > 0 && <p className="scene-hint">Select an object to edit its position, rotation and scale.</p>}
          </Section>

          <Section title="Lighting" hidden={isBlock} open={sections.lighting} onToggle={() => toggleSection('lighting')}>
            <div className="scene-subhead">Sun</div>
            <SliderRow label="Intensity" value={lighting.sunIntensity} min={0} max={10} step={0.1} onChange={value => setLighting({sunIntensity: value})} />
            <ColorRow label="Colour" value={lighting.sunColor} onChange={value => setLighting({sunColor: value})} />
            <SliderRow label="Azimuth" value={lighting.sunAzimuth} min={0} max={360} step={1} onChange={value => setLighting({sunAzimuth: value})} />
            <SliderRow label="Elevation" value={lighting.sunElevation} min={0} max={90} step={1} onChange={value => setLighting({sunElevation: value})} />
            <ToggleRow label="Shadows" checked={lighting.shadows} onChange={value => setLighting({shadows: value})} />
            <div className="scene-subhead">Ambient</div>
            <SliderRow label="Intensity" value={lighting.ambientIntensity} min={0} max={5} step={0.05} onChange={value => setLighting({ambientIntensity: value})} />
            <ColorRow label="Colour" value={lighting.ambientColor} onChange={value => setLighting({ambientColor: value})} />
            <div className="scene-subhead">Camera</div>
            <SliderRow label="Exposure" value={lighting.exposure} min={0.1} max={3} step={0.05} onChange={value => setLighting({exposure: value})} />
          </Section>

          <Section title="Environment" hidden={isBlock} open={sections.environment} onToggle={() => toggleSection('environment')}>
            <Segmented label="Environment type" options={ENVIRONMENT_TYPES} value={environment.type} onChange={value => setEnvironment({type: value})} />

            {environment.type === 'sky' && (
              <>
                <SliderRow label="Turbidity" value={environment.turbidity} min={0} max={20} step={0.1} onChange={value => setEnvironment({turbidity: value})} />
                <SliderRow label="Rayleigh" value={environment.rayleigh} min={0} max={4} step={0.05} onChange={value => setEnvironment({rayleigh: value})} />
                <p className="scene-hint">The sky follows the sun's azimuth and elevation.</p>
              </>
            )}
            {environment.type === 'gradient' && (
              <>
                <ColorRow label="Top" value={environment.topColor} onChange={value => setEnvironment({topColor: value})} />
                <ColorRow label="Bottom" value={environment.bottomColor} onChange={value => setEnvironment({bottomColor: value})} />
              </>
            )}
            {environment.type === 'image' && (
              <>
                {images.length > 0 ? (
                  <Picker
                    id="scene-environment-image"
                    label="Environment image"
                    options={imageOptions}
                    value={imageValue}
                    onChange={value => {
                      if (value !== draftRef.current.environment.imageAssetId) setEnvironment({imageAssetId: value});
                    }}
                  />
                ) : (
                  <p className="scene-hint">Add a texture or reference image to the library to use it here.</p>
                )}
                {environmentStatus === 'loading' && <p className="scene-hint">Loading image…</p>}
                {environmentStatus === 'error' && <p className="scene-hint scene-hint-error">That image could not be loaded.</p>}
                {images.length > 0 && <p className="scene-hint">Equirectangular (2:1) panoramas work best.</p>}
              </>
            )}

            {environment.type !== 'color' && (
              <ToggleRow label="Show background" checked={environment.showBackground} onChange={value => setEnvironment({showBackground: value})} />
            )}
            {(environment.type === 'color' || !environment.showBackground || environment.type === 'image') && (
              <ColorRow label={environment.type === 'color' ? 'Colour' : 'Backdrop'} value={environment.color} onChange={value => setEnvironment({color: value})} />
            )}

            <div className="scene-subhead">Ground</div>
            <Segmented label="Ground" options={GROUND_TYPES} value={environment.ground} onChange={value => setEnvironment({ground: value})} />
          </Section>
        </aside>
        );
        // Docked: the app shows the panel in its side panel, next to the chat.
        if (dockPanel) return panelHost ? createPortal(panel, panelHost) : null;
        return panelOpen ? panel : null;
      })()}
    </div>
  );
});

export default SceneView;
