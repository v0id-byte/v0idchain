import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import TilePicker from './dev/TilePicker';
import Gallery from './dev/Gallery';
import SceneView from './dev/SceneView';
import './styles.css';

// ?pick → 图集坐标拾取；?gallery → 建模验收台；?scene=<id> → 静态场景验收（均开发用，验收完即可移除）
const Root = location.search.includes('pick') ? TilePicker
  : location.search.includes('gallery') ? Gallery
  : location.search.includes('scene') ? SceneView
  : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
