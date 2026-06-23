import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import TilePicker from './dev/TilePicker';
import './styles.css';

// ?pick → 临时图集坐标拾取工具（开发用，映射完即可移除）
const Root = location.search.includes('pick') ? TilePicker : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
