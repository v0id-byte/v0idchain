// React ↔ 引擎的桥：建画布、起引擎、转交互/点击回调。门切场景在这里;编辑时家具/主题变化就地重建房间。
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { GameEngine } from '../engine/game';
import { buildRoom, buildTown, buildFarm, type Interactable, type FurnitureItem, type GardenStateEntry } from '../engine/scene';
import { buildNpcRoom } from '../engine/npc-rooms';
import type { RoomThemeId } from '../engine/tileset';
import type { FarmView } from '@v0idchain/core/browser';

interface Props {
  address: string;
  petGene: string | null;
  petFollow?: boolean; // 自家场景跟随玩家；串门(false)时主人的崽静态摆基座
  furniture: FurnitureItem[];
  theme: RoomThemeId;
  editMode: boolean;
  paused: boolean;
  visit?: { furniture: FurnitureItem[]; theme: RoomThemeId } | null; // 串门:渲染他人(只读)房间
  farm?: FarmView | null; // 自家农场状态（buildFarm 用）
  depletedFruits?: ReadonlySet<string>; // 已摘取的果树 id，传给 buildTown 过滤
  choppedTrees?: ReadonlySet<string>;   // 已砍倒的果树 id，从 buildTown 移除
  gardenState?: ReadonlyMap<string, GardenStateEntry>; // 田地格状态（阶段/作物/精灵）
  onToggleMenu: () => void;
  onInteract: (it: Interactable) => void;
  onNearby?: (it: Interactable | null) => void;
  onSceneChange?: (id: string) => void;
  onTileClick?: (tx: number, ty: number, sceneId: string) => void;
}

// 触屏控件经此句柄把方向/交互推给引擎（与键盘走同一条 update() 逻辑，桌面零回归）。
export interface GameHandle {
  setTouchDir: (dx: number, dy: number) => void;
  touchInteract: () => void;
}

const GameView = forwardRef<GameHandle, Props>(function GameView(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const sceneRef = useRef<string>('room');
  // 进入 npc:* 房间时记录镇地图中该建筑门的坐标，出门回镇时在门口出现而非出生点
  const entryDoorRef = useRef<{ x: number; y: number } | null>(null);

  useImperativeHandle(ref, () => ({
    setTouchDir: (dx, dy) => engineRef.current?.setTouchDir(dx, dy),
    touchInteract: () => engineRef.current?.touchInteract(),
  }), []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const buildCurrentRoom = () => {
      const v = propsRef.current.visit;
      return v ? buildRoom(v.furniture, v.theme) : buildRoom(propsRef.current.furniture, propsRef.current.theme);
    };
    const buildScene = (id: string, spawnOverride?: { x: number; y: number }) => {
      if (id === 'town') return buildTown(propsRef.current.depletedFruits, propsRef.current.choppedTrees, spawnOverride, propsRef.current.gardenState);
      if (id === 'farm') return buildFarm(propsRef.current.farm ?? null);
      if (id.startsWith('npc:')) return buildNpcRoom(id.slice(4));
      return buildCurrentRoom();
    };
    const engine = new GameEngine(cv, props.address, {
      onToggleMenu: () => propsRef.current.onToggleMenu(),
      onNearby: (it) => propsRef.current.onNearby?.(it),
      onInteract: (it) => {
        if (it.type === 'door' && it.target) {
          const target = it.target;
          if (target.startsWith('npc:')) {
            // 记录进入建筑的门坐标（镇地图坐标），出门时在此处生成
            entryDoorRef.current = { x: it.x, y: it.y };
          }
          let spawnOverride: { x: number; y: number } | undefined;
          if (target === 'town' && entryDoorRef.current) {
            // 在建筑门口一格南侧出现，而不是回到镇中心出生点
            spawnOverride = { x: entryDoorRef.current.x, y: entryDoorRef.current.y + 1 };
            entryDoorRef.current = null;
          }
          sceneRef.current = target;
          engine.setScene(buildScene(target, spawnOverride));
          propsRef.current.onSceneChange?.(target);
        } else {
          propsRef.current.onInteract(it);
        }
      },
      onTileClick: (tx, ty, sid) => propsRef.current.onTileClick?.(tx, ty, sid),
    });
    sceneRef.current = 'room';
    engine.setScene(buildCurrentRoom());
    engine.setPetGene(props.petGene);
    engine.setPetFollow(props.petFollow ?? true);
    engine.start();
    engineRef.current = engine;
    (window as unknown as { __goScene?: (id: string) => void }).__goScene = (id: string) => {
      sceneRef.current = id;
      engine.setScene(buildScene(id));
    };
    return () => engine.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.address]);

  useEffect(() => {
    engineRef.current?.setPaused(props.paused);
  }, [props.paused]);
  useEffect(() => {
    engineRef.current?.setPetGene(props.petGene);
  }, [props.petGene]);
  useEffect(() => {
    engineRef.current?.setPetFollow(props.petFollow ?? true);
  }, [props.petFollow]);
  useEffect(() => {
    engineRef.current?.setEditMode(props.editMode);
  }, [props.editMode]);
  // 家具/主题变化(自己房间、非串门):就地重建保留位置
  useEffect(() => {
    if (engineRef.current && sceneRef.current === 'room' && !props.visit) {
      engineRef.current.setScene(buildRoom(props.furniture, props.theme), false);
    }
  }, [props.furniture, props.theme, props.visit]);
  // 串门:选了某人 → 切到他的(只读)房间
  useEffect(() => {
    if (engineRef.current && props.visit) {
      sceneRef.current = 'room';
      engineRef.current.setScene(buildRoom(props.visit.furniture, props.visit.theme), true);
    }
  }, [props.visit]);
  // 农场状态变化(种植/收获/买地后)且正在农场:就地重建(不回出生点,保留站位)
  useEffect(() => {
    if (engineRef.current && sceneRef.current === 'farm') {
      engineRef.current.setScene(buildFarm(props.farm ?? null), false);
    }
  }, [props.farm]);
  // 果树/菜地状态变化时，若在镇中心则就地重建
  useEffect(() => {
    if (engineRef.current && sceneRef.current === 'town') {
      engineRef.current.setScene(buildTown(props.depletedFruits, props.choppedTrees, undefined, props.gardenState), false);
    }
  }, [props.depletedFruits, props.choppedTrees, props.gardenState]);

  return <canvas ref={canvasRef} className="game-canvas" />;
});

export default GameView;
