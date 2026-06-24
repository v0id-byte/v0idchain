import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import TilePicker from './dev/TilePicker';
import Gallery from './dev/Gallery';
import './styles.css';

// ?pick → 图集坐标拾取；?gallery → 美术建模验收台（均开发用，验收完即可移除）
const Root = location.search.includes('pick') ? TilePicker
  : location.search.includes('gallery') ? Gallery
  : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
