// React ↔ 引擎的桥：建画布、起引擎、转交互/点击回调。门切场景在这里;编辑时家具/主题变化就地重建房间。
import { useEffect, useRef } from 'react';
import { GameEngine } from '../engine/game';
import { buildRoom, buildTown, type Interactable, type FurnitureItem } from '../engine/scene';
import type { RoomThemeId } from '../engine/tileset';

interface Props {
  address: string;
  petGene: string | null;
  furniture: FurnitureItem[];
  theme: RoomThemeId;
  editMode: boolean;
  paused: boolean;
  visit?: { furniture: FurnitureItem[]; theme: RoomThemeId } | null; // 串门:渲染他人(只读)房间
  onToggleMenu: () => void;
  onInteract: (it: Interactable) => void;
  onSceneChange?: (id: string) => void;
  onTileClick?: (tx: number, ty: number, sceneId: string) => void;
}

export default function GameView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const sceneRef = useRef<string>('room');

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const buildCurrentRoom = () => {
      const v = propsRef.current.visit;
      return v ? buildRoom(v.furniture, v.theme) : buildRoom(propsRef.current.furniture, propsRef.current.theme);
    };
    const engine = new GameEngine(cv, props.address, {
      onToggleMenu: () => propsRef.current.onToggleMenu(),
      onInteract: (it) => {
        if (it.type === 'door' && it.target) {
          sceneRef.current = it.target;
          engine.setScene(it.target === 'town' ? buildTown() : buildCurrentRoom());
          propsRef.current.onSceneChange?.(it.target);
        } else {
          propsRef.current.onInteract(it);
        }
      },
      onTileClick: (tx, ty, sid) => propsRef.current.onTileClick?.(tx, ty, sid),
    });
    sceneRef.current = 'room';
    engine.setScene(buildCurrentRoom());
    engine.setPetGene(props.petGene);
    engine.start();
    engineRef.current = engine;
    (window as unknown as { __goScene?: (id: string) => void }).__goScene = (id: string) => {
      sceneRef.current = id;
      engine.setScene(id === 'town' ? buildTown() : buildCurrentRoom());
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

  return <canvas ref={canvasRef} className="game-canvas" />;
}
