// App.tsx
import React, { useMemo, useState, useEffect, useRef } from "react";
import {
  Info,
  Download,
  Settings,
  Calculator,
  Wrench,
  Database,
  Upload,
  Save,
  Sparkles,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
// ★3D表示（軽快なWebプレビュー）※現状UIでは未使用（必要なら後で配置）
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
} from "@react-three/drei";

/* ==========================================
   (C) アンカー コンクリ側引張：係数まとめ（追加）
   置き場所：import の直後
   ========================================== */
const ANCHOR_CONC = {
  // 係数（安全側の簡易モデル用）
  // fck は N/mm2 を想定（= Fc）
  // hef は mm を想定
  // 単純化のため、複数低減をまとめて掛ける
  k: 7.0, // 基本係数（簡易コーン破壊モデル用）
  phi: 0.75, // 強度低減（安全側）
  psiEdge: 0.85, // 端部・群効果などの簡易低減（安全側）
  psiCrack: 0.85, // ひび割れ等の簡易低減（安全側）
};

/* ==========================================
   (D) 根入れ抵抗（受働土圧）を簡易で加味（追加）
   - 転倒：抵抗モーメントに加算
   - 滑動：抵抗水平力に加算
   ※地盤定数が無い簡易のため、Kpは代表値（砂質土φ=30°程度）を固定
   ========================================== */
const PASSIVE_SOIL = {
  Kp: 3.0, // 受働土圧係数の代表値（簡易）
};

/**
 * サイン構造計算(簡易版) — B版＋基礎深さH＋完全計算版（qa/Fc/μ・アンカー埋込み反映）
 * + 柱本数 postQty：荷重を1本あたりに分担して検定（独立基礎モデル）
 * 追加仕様（今回反映）：
 * - 自立看板：アンカーは ABR 規格（短期許容引張/せん断）を選択肢に固定
 * - 自立看板：有効埋込み長さ hef は 20d 以上（強制）
 * - ベースプレート板厚 t(採用)：16/19/22/25/28/32/36 mm のみ選択可（AI自動計算も同系列に丸め）
 * - (C) アンカーのコンクリ側引張耐力：楽観式ではなく安全側簡易モデル（係数）を採用
 * - (D) 自立看板の基礎鉛直荷重：土被り重量を加算
 * - (D) 自立看板の根入れ抵抗：受働土圧を簡易で加味（転倒・滑動）
 * - UI は純粋な HTML 要素のみ（独自 UI ライブラリへの import なし）
 */

const G = 9.8; // m/s^2

// ===== 風：基準速度圧（動圧）=====
// q0 = 0.613 V^2 [N/m2] を「基準速度圧」として扱い、以降の係数で設計速度圧 qz を作る。
const wind_q0 = (V0: number) => 0.613 * V0 * V0; // N/m²

// ===== 風：設計速度圧（whatIf 用）=====
// 風速 V を与えたときの設計速度圧 qz を返す
// ※ CfMode により Kz/Gf/Iw/Kd/Kt の有効・無効（=1.0扱い）を切替
const windPressure = (
  V: number,
  params: {
    cfMode: "SHAPE_ONLY" | "CF_INCLUDES_ALL";
    windKz: number;
    windGf: number;
    windIw: number;
    windKd: number;
    windKt: number;
  }
) => {
  const q0v = wind_q0(V);

  const Kz_eff = params.cfMode === "CF_INCLUDES_ALL" ? 1.0 : params.windKz;
  const Gf_eff = params.cfMode === "CF_INCLUDES_ALL" ? 1.0 : params.windGf;
  const Iw_eff = params.cfMode === "CF_INCLUDES_ALL" ? 1.0 : params.windIw;
  const Kd_eff = params.cfMode === "CF_INCLUDES_ALL" ? 1.0 : params.windKd;
  const Kt_eff = params.cfMode === "CF_INCLUDES_ALL" ? 1.0 : params.windKt;

  return q0v * Kz_eff * Gf_eff * Iw_eff * Kd_eff * Kt_eff; // N/m²
};

const sigmaAllow = (Fy: number) => (2 / 3) * Fy; // N/mm²（一時設計）
const toKgf = (N: number) => N / G;

const fmt = (n: any, unit = "", digits = 2) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}${unit}`;
};

const showF = (N: number, unit: string) =>
  unit === "kgf" ? `${toKgf(N).toFixed(1)} kgf` : `${N.toFixed(1)} N`;
const showM = (Nm: number, unit: string) =>
  unit === "kgf" ? `${toKgf(Nm).toFixed(1)} kgf·m` : `${Nm.toFixed(1)} N·m`;

const roundByMode = (v: number, d: number, mode: string) => {
  const f = Math.pow(10, d);
  if (!Number.isFinite(v)) return v;
  if (mode === "ceil") return Math.ceil(v * f) / f;
  if (mode === "floor") return Math.floor(v * f) / f;
  return Math.round(v * f) / f;
};
const fmtByMode = (v: number, d: number, mode: string, suf = "") => {
  if (!Number.isFinite(v)) return "—";
  const x = roundByMode(v, d, mode);
  return `${x.toFixed(d)}${suf}`;
};

// ===== ベースプレート板厚（採用品） =====
const PLATE_T_OPTIONS = [16, 19, 22, 25, 28, 32, 36];
const snapPlateT = (tReq: number) => {
  for (const t of PLATE_T_OPTIONS) if (t >= tReq) return t;
  return PLATE_T_OPTIONS[PLATE_T_OPTIONS.length - 1];
};

// Σy² 配分（2×2アンカー想定）
function computeAnchorTensions(
  M: number,
  anchorGauge: number,
  anchorPitch: number
) {
  const xh = anchorPitch / 2; // mm
  const yh = anchorGauge / 2; // mm
  const coords = [
    { id: "UL", x: -xh, y: +yh },
    { id: "UR", x: +xh, y: +yh },
    { id: "LL", x: -xh, y: -yh },
    { id: "LR", x: +xh, y: -yh },
  ];
  const sumY2 = coords.reduce((s, c) => s + Math.pow(c.y / 1000, 2), 0); // m²
  const list = coords.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    T: sumY2 > 0 ? (M * (c.y / 1000)) / sumY2 : 0,
  }));
  return { list, sumY2 };
}

// 片持ちストリップ板厚（簡易・集中荷重モデル）
function computePlateThickness(
  T_row: number,
  a_mm: number,
  s_mm: number,
  plateFy: number
) {
  const sigma_a_plate = sigmaAllow(plateFy); // N/mm²
  const m_Nmm_per_mm = (T_row * a_mm) / Math.max(1, s_mm); // N·mm/mm
  return Math.sqrt((6 * m_Nmm_per_mm) / Math.max(sigma_a_plate, 1)); // mm
}

// ===== 日本語ファミリ表記 =====
const FAMILY_JP_MAP: Record<string, string> = {
  H: "H形鋼",
  LH: "軽量H形鋼",
  CT: "CT形鋼",
  C: "みぞ形鋼",
  CLIP: "リップみぞ形鋼",
  I: "I形鋼",
  PIPE: "鋼管",
  SHS: "角形鋼管",
  FLAT: "平鋼",
  ROUND: "丸鋼",
  L: "L形鋼",
};

type AnchorSpec = {
  name: string;
  d: number;
  Ta: number;
  Va: number;
  min_e?: number;
  min_s?: number;
  hefRec?: number;
};
type SectionSpec = {
  family: string;
  name: string;
  A_cm2?: number;
  w_kgpm?: number;
  Ix_cm4?: number;
  Iy_cm4?: number;
  ix_cm?: number;
  iy_cm?: number;
  Zx_cm3?: number;
  Zy_cm3?: number;
};

const DEFAULT_ANCHORS: AnchorSpec[] = [
  {
    name: "M12 A-BOLT",
    d: 12,
    Ta: 12000,
    Va: 5000,
    min_e: 18,
    min_s: 36,
    hefRec: 150,
  },
  {
    name: "M16 A-BOLT",
    d: 16,
    Ta: 22000,
    Va: 9000,
    min_e: 24,
    min_s: 48,
    hefRec: 200,
  },
  {
    name: "M20 A-BOLT",
    d: 20,
    Ta: 35000,
    Va: 14000,
    min_e: 30,
    min_s: 60,
    hefRec: 250,
  },
  {
    name: "M24 A-BOLT",
    d: 24,
    Ta: 51000,
    Va: 20000,
    min_e: 36,
    min_s: 72,
    hefRec: 300,
  },
  {
    name: "M30 A-BOLT",
    d: 30,
    Ta: 75000,
    Va: 30000,
    min_e: 45,
    min_s: 90,
    hefRec: 380,
  },
  {
    name: "M32 A-BOLT",
    d: 32,
    Ta: 90000,
    Va: 36000,
    min_e: 48,
    min_s: 96,
    hefRec: 420,
  },
];

// ===== 自立看板用：ABRアンカー（短期許容） =====
const ABR_ANCHORS: AnchorSpec[] = [
  { name: "M16 ABR", d: 16, Ta: 36.9e3, Va: 21.3e3 },
  { name: "M20 ABR", d: 20, Ta: 57.6e3, Va: 33.2e3 },
  { name: "M22 ABR", d: 22, Ta: 71.2e3, Va: 41.1e3 },
  { name: "M24 ABR", d: 24, Ta: 83.0e3, Va: 47.9e3 },
  { name: "M27 ABR", d: 27, Ta: 108e3, Va: 62.4e3 },
  { name: "M30 ABR", d: 30, Ta: 132e3, Va: 76.2e3 },
  { name: "M33 ABR", d: 33, Ta: 163e3, Va: 94.1e3 },
  { name: "M36 ABR", d: 36, Ta: 192e3, Va: 111e3 },
  { name: "M39 ABR", d: 39, Ta: 229e3, Va: 132e3 },
  { name: "M42 ABR", d: 42, Ta: 263e3, Va: 152e3 },
  { name: "M45 ABR", d: 45, Ta: 282e3, Va: 163e3 },
  { name: "M48 ABR", d: 48, Ta: 316e3, Va: 182e3 },
].map((a) => ({
  ...a,
  hefRec: a.d * 20, // 自立は 20d（表示用）
}));

const DEFAULT_SECTIONS: SectionSpec[] = [
  // ==== H形鋼（よく使いそうなサイズを抜粋） ====
  {
    family: "H",
    name: "H-100×50×5×7",
    Zx_cm3: 37.5,
    Zy_cm3: 5.91,
    ix_cm: 3.98,
    iy_cm: 1.12,
  },
  {
    family: "H",
    name: "H-100×100×6×8",
    Zx_cm3: 75.6,
    Zy_cm3: 26.7,
    ix_cm: 4.18,
    iy_cm: 2.49,
  },
  {
    family: "H",
    name: "H-125×60×6×8",
    Zx_cm3: 65.5,
    Zy_cm3: 9.71,
    ix_cm: 4.95,
    iy_cm: 1.32,
  },
  {
    family: "H",
    name: "H-150×75×5×7",
    Zx_cm3: 88.8,
    Zy_cm3: 13.2,
    ix_cm: 6.11,
    iy_cm: 1.66,
  },
  {
    family: "H",
    name: "H-150×150×7×10",
    Zx_cm3: 216,
    Zy_cm3: 75.1,
    ix_cm: 6.4,
    iy_cm: 3.77,
  },
  {
    family: "H",
    name: "H-175×175×7.5×11",
    Zx_cm3: 331,
    Zy_cm3: 112,
    ix_cm: 7.5,
    iy_cm: 4.37,
  },
  {
    family: "H",
    name: "H-200×100×5.5×8",
    Zx_cm3: 181,
    Zy_cm3: 26.7,
    ix_cm: 8.23,
    iy_cm: 2.24,
  },
  {
    family: "H",
    name: "H-200×200×8×12",
    Zx_cm3: 472,
    Zy_cm3: 160,
    ix_cm: 8.62,
    iy_cm: 5.02,
  },

  // ==== CT形鋼 ====
  {
    family: "CT",
    name: "CT-50×50×5×7",
    Zx_cm3: 3.18,
    Zy_cm3: 2.96,
    ix_cm: 1.41,
    iy_cm: 1.12,
  },
  {
    family: "CT",
    name: "CT-75×75×5×7",
    Zx_cm3: 7.46,
    Zy_cm3: 6.6,
    ix_cm: 2.18,
    iy_cm: 1.66,
  },
  {
    family: "CT",
    name: "CT-100×100×5.5×8",
    Zx_cm3: 14.8,
    Zy_cm3: 13.4,
    ix_cm: 2.93,
    iy_cm: 2.24,
  },
  {
    family: "CT",
    name: "CT-125×125×6×9",
    Zx_cm3: 25.6,
    Zy_cm3: 23.5,
    ix_cm: 3.66,
    iy_cm: 2.82,
  },
  {
    family: "CT",
    name: "CT-150×150×6.5×9",
    Zx_cm3: 40.0,
    Zy_cm3: 33.8,
    ix_cm: 4.45,
    iy_cm: 3.29,
  },
  {
    family: "CT",
    name: "CT-175×175×7×11",
    Zx_cm3: 60.2,
    Zy_cm3: 51.0,
    ix_cm: 5.1,
    iy_cm: 3.95,
  },
  {
    family: "CT",
    name: "CT-200×200×8×12",
    Zx_cm3: 90.5,
    Zy_cm3: 76.3,
    ix_cm: 5.92,
    iy_cm: 4.5,
  },
  {
    family: "CT",
    name: "CT-250×250×9×14",
    Zx_cm3: 150.4,
    Zy_cm3: 126.8,
    ix_cm: 7.4,
    iy_cm: 5.6,
  },
  {
    family: "CT",
    name: "CT-300×300×10×15",
    Zx_cm3: 228.6,
    Zy_cm3: 193.5,
    ix_cm: 8.85,
    iy_cm: 6.72,
  },
  {
    family: "CT",
    name: "CT-350×350×12×18",
    Zx_cm3: 340.3,
    Zy_cm3: 285.7,
    ix_cm: 10.4,
    iy_cm: 8.05,
  },

  // ==== L形鋼 ====
  {
    family: "L",
    name: "L-40×40×3",
    Zx_cm3: 1.21,
    Zy_cm3: 1.21,
    ix_cm: 1.23,
    iy_cm: 1.23,
  },
  {
    family: "L",
    name: "L-50×50×4",
    Zx_cm3: 2.49,
    Zy_cm3: 2.49,
    ix_cm: 1.53,
    iy_cm: 1.53,
  },
  {
    family: "L",
    name: "L-65×65×6",
    Zx_cm3: 6.27,
    Zy_cm3: 6.27,
    ix_cm: 1.98,
    iy_cm: 1.98,
  },
  {
    family: "L",
    name: "L-75×75×6",
    Zx_cm3: 8.47,
    Zy_cm3: 8.47,
    ix_cm: 2.3,
    iy_cm: 2.3,
  },
  {
    family: "L",
    name: "L-90×90×7",
    Zx_cm3: 14.2,
    Zy_cm3: 14.2,
    ix_cm: 2.76,
    iy_cm: 2.76,
  },
  {
    family: "L",
    name: "L-100×100×8",
    Zx_cm3: 21.3,
    Zy_cm3: 21.3,
    ix_cm: 3.3,
    iy_cm: 3.3,
  },
  {
    family: "L",
    name: "L-125×125×9",
    Zx_cm3: 36.8,
    Zy_cm3: 36.8,
    ix_cm: 4.15,
    iy_cm: 4.15,
  },
  {
    family: "L",
    name: "L-150×150×12",
    Zx_cm3: 70.2,
    Zy_cm3: 70.2,
    ix_cm: 5.25,
    iy_cm: 5.25,
  },
  {
    family: "L",
    name: "L-200×200×15",
    Zx_cm3: 144.0,
    Zy_cm3: 144.0,
    ix_cm: 6.8,
    iy_cm: 6.8,
  },
  {
    family: "L",
    name: "L-250×250×18",
    Zx_cm3: 254.0,
    Zy_cm3: 254.0,
    ix_cm: 8.4,
    iy_cm: 8.4,
  },

  // ==== みぞ形鋼（Cチャン） ====
  {
    family: "C",
    name: "みぞ形鋼-75×40×5×7",
    Zx_cm3: 20.2,
    Zy_cm3: 4.54,
    ix_cm: 2.93,
    iy_cm: 1.19,
  },
  {
    family: "C",
    name: "みぞ形鋼-100×50×5×7.5",
    Zx_cm3: 37.8,
    Zy_cm3: 7.82,
    ix_cm: 3.98,
    iy_cm: 1.5,
  },
  {
    family: "C",
    name: "みぞ形鋼-125×65×6×8",
    Zx_cm3: 68.0,
    Zy_cm3: 14.4,
    ix_cm: 4.99,
    iy_cm: 1.96,
  },
  {
    family: "C",
    name: "みぞ形鋼-150×75×6.5×10",
    Zx_cm3: 115,
    Zy_cm3: 23.6,
    ix_cm: 6.04,
    iy_cm: 2.27,
  },
  {
    family: "C",
    name: "みぞ形鋼-200×70×7×10",
    Zx_cm3: 162,
    Zy_cm3: 21.8,
    ix_cm: 7.77,
    iy_cm: 2.04,
  },

  // ==== リップみぞ形鋼（LC） ====
  {
    family: "CLIP",
    name: "リップみぞ形鋼-60×30×10×1.6",
    Zx_cm3: 3.88,
    Zy_cm3: 1.32,
    ix_cm: 2.37,
    iy_cm: 1.11,
  },
  {
    family: "CLIP",
    name: "リップみぞ形鋼-75×45×15×1.6",
    Zx_cm3: 7.24,
    Zy_cm3: 3.13,
    ix_cm: 3.03,
    iy_cm: 1.72,
  },
  {
    family: "CLIP",
    name: "リップみぞ形鋼-100×50×20×1.6",
    Zx_cm3: 11.7,
    Zy_cm3: 4.36,
    ix_cm: 3.99,
    iy_cm: 1.95,
  },
  {
    family: "CLIP",
    name: "リップみぞ形鋼-100×50×20×3.2",
    Zx_cm3: 21.3,
    Zy_cm3: 7.81,
    ix_cm: 3.9,
    iy_cm: 1.87,
  },
  {
    family: "CLIP",
    name: "リップみぞ形鋼-120×60×20×3.2",
    Zx_cm3: 31.0,
    Zy_cm3: 10.5,
    ix_cm: 4.74,
    iy_cm: 2.22,
  },

  // ==== I形鋼 ====
  {
    family: "I",
    name: "I-100×75×5×8",
    Zx_cm3: 56.5,
    Zy_cm3: 12.9,
    ix_cm: 4.15,
    iy_cm: 1.72,
  },
  {
    family: "I",
    name: "I-150×75×5.5×9.5",
    Zx_cm3: 109,
    Zy_cm3: 15.8,
    ix_cm: 6.13,
    iy_cm: 1.65,
  },
  {
    family: "I",
    name: "I-200×100×7×10",
    Zx_cm3: 218,
    Zy_cm3: 28.4,
    ix_cm: 8.11,
    iy_cm: 2.07,
  },
  {
    family: "I",
    name: "I-250×125×7.5×12.5",
    Zx_cm3: 415,
    Zy_cm3: 55.2,
    ix_cm: 10.3,
    iy_cm: 2.66,
  },
  {
    family: "I",
    name: "I-300×150×8×13",
    Zx_cm3: 633,
    Zy_cm3: 80.0,
    ix_cm: 12.4,
    iy_cm: 3.12,
  },

  // ==== 角形鋼管（追加9種類） ====
  {
    family: "SHS",
    name: "角形鋼管-50×50×3.2",
    Zx_cm3: 20.7,
    Zy_cm3: 20.7,
    ix_cm: 1.75,
    iy_cm: 1.75,
  },
  {
    family: "SHS",
    name: "角形鋼管-75×75×4.5",
    Zx_cm3: 54.3,
    Zy_cm3: 54.3,
    ix_cm: 2.65,
    iy_cm: 2.65,
  },
  {
    family: "SHS",
    name: "角形鋼管-100×100×4.5",
    Zx_cm3: 102,
    Zy_cm3: 102,
    ix_cm: 3.48,
    iy_cm: 3.48,
  },
  {
    family: "SHS",
    name: "角形鋼管-100×100×6",
    Zx_cm3: 129,
    Zy_cm3: 129,
    ix_cm: 3.43,
    iy_cm: 3.43,
  },
  {
    family: "SHS",
    name: "角形鋼管-125×125×6",
    Zx_cm3: 207,
    Zy_cm3: 207,
    ix_cm: 4.55,
    iy_cm: 4.55,
  },
  {
    family: "SHS",
    name: "角形鋼管-150×150×4.5",
    Zx_cm3: 171,
    Zy_cm3: 171,
    ix_cm: 4.09,
    iy_cm: 4.09,
  },
  {
    family: "SHS",
    name: "角形鋼管-200×200×6",
    Zx_cm3: 416,
    Zy_cm3: 416,
    ix_cm: 6.45,
    iy_cm: 6.45,
  },
  {
    family: "SHS",
    name: "角形鋼管-200×200×9",
    Zx_cm3: 585,
    Zy_cm3: 585,
    ix_cm: 6.29,
    iy_cm: 6.29,
  },
  {
    family: "SHS",
    name: "角形鋼管-250×250×9",
    Zx_cm3: 1020,
    Zy_cm3: 1020,
    ix_cm: 7.86,
    iy_cm: 7.86,
  },

  // ==== 鋼管 PIPE（10種類）====
  {
    family: "PIPE",
    name: "鋼管-48.6×2.3",
    Zx_cm3: 5.48,
    Zy_cm3: 5.48,
    ix_cm: 1.72,
    iy_cm: 1.72,
  },
  {
    family: "PIPE",
    name: "鋼管-60.5×2.3",
    Zx_cm3: 9.18,
    Zy_cm3: 9.18,
    ix_cm: 2.14,
    iy_cm: 2.14,
  },
  {
    family: "PIPE",
    name: "鋼管-76.3×3.2",
    Zx_cm3: 20.4,
    Zy_cm3: 20.4,
    ix_cm: 2.8,
    iy_cm: 2.8,
  },
  {
    family: "PIPE",
    name: "鋼管-89.1×3.2",
    Zx_cm3: 28.7,
    Zy_cm3: 28.7,
    ix_cm: 3.28,
    iy_cm: 3.28,
  },
  {
    family: "PIPE",
    name: "鋼管-101.6×3.2",
    Zx_cm3: 38.8,
    Zy_cm3: 38.8,
    ix_cm: 3.73,
    iy_cm: 3.73,
  },
  {
    family: "PIPE",
    name: "鋼管-114.3×3.5",
    Zx_cm3: 56.4,
    Zy_cm3: 56.4,
    ix_cm: 4.26,
    iy_cm: 4.26,
  },
  {
    family: "PIPE",
    name: "鋼管-139.8×4.5",
    Zx_cm3: 104.1,
    Zy_cm3: 104.1,
    ix_cm: 5.34,
    iy_cm: 5.34,
  },
  {
    family: "PIPE",
    name: "鋼管-165.2×4.5",
    Zx_cm3: 144.3,
    Zy_cm3: 144.3,
    ix_cm: 6.28,
    iy_cm: 6.28,
  },
  {
    family: "PIPE",
    name: "鋼管-216.3×6.0",
    Zx_cm3: 314.0,
    Zy_cm3: 314.0,
    ix_cm: 8.3,
    iy_cm: 8.3,
  },
  {
    family: "PIPE",
    name: "鋼管-267.4×6.6",
    Zx_cm3: 535.0,
    Zy_cm3: 535.0,
    ix_cm: 10.4,
    iy_cm: 10.4,
  },
];

export default function App() {
  // ===== 表示・PDF =====
  const [forceUnit, setForceUnit] = useState("N");
  const [pdfSigmaDigits, setPdfSigmaDigits] = useState(2);
  const [pdfMDigits, setPdfMDigits] = useState(1);
  const [pdfRoundingMode, setPdfRoundingMode] = useState("round");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ===== 指示書（PDF）用の追加情報 =====
  const [projectName, setProjectName] = useState("");
  const [projectNo, setProjectNo] = useState("");
  const [rev, setRev] = useState("A");
  const [author, setAuthor] = useState("");
  const [checker, setChecker] = useState("");
  const [approver, setApprover] = useState("");

  // 製作・施工で迷うポイントを明示するための入力
  const [plateD, setPlateD] = useState(0.4); // m（ベースプレート奥行）
  const [holeClearance, setHoleClearance] = useState(2); // mm（孔径= d + clearance）
  const [finishSpec, setFinishSpec] = useState("未定");
  const [concSpec, setConcSpec] = useState(
    "Fc=入力値、スランプ/養生は現場仕様"
  );
  const [siteNotes, setSiteNotes] = useState("");

  // 法令・基準（告示1456号など）を“条文番号まで”明示する欄
  const [lawRef, setLawRef] = useState("告示1456号（　条　項）");

  // ===== サイン種別 =====
  const [signType, setSignType] = useState("freestanding"); // freestanding | projecting | wall

  // ===== パネル =====
  const [width, setWidth] = useState(3.0);
  const [height, setHeight] = useState(2.0);
  const [panelKg, setPanelKg] = useState(250);
  const [cgHeight, setCgHeight] = useState(3.5);

  // ===== 断面DB =====
  const [sections, setSections] = useState<SectionSpec[]>(DEFAULT_SECTIONS);
  const families = [...new Set(sections.map((s) => s.family))];
  const [family, setFamily] = useState(sections[0].family);
  const candidates = sections.filter((s) => s.family === family);
  const [sectionName, setSectionName] = useState(candidates[0]?.name || "");
  const [bendAxis, setBendAxis] = useState("x");

  // ===== 材料・部材 =====
  const [Fy, setFy] = useState(235); // N/mm²
  const [K, setK] = useState(1.0);
  const [L, setL] = useState(3.0); // m

  // ★柱本数 postQty（同じ断面・同条件の柱が何本あるか）
  const [postQty, setPostQty] = useState(1);

  // ★柱間連結（耐風梁・ブレース等）あり前提か？
  const [hasInterPostConnection, setHasInterPostConnection] = useState(true);

  // ===== アンカー（非自立用DBを保持。自立は ABR 固定リストを使用） =====
  const [anchors, setAnchors] = useState<AnchorSpec[]>(DEFAULT_ANCHORS);

  const initialABR =
    ABR_ANCHORS.find((a) => a.d === 27) || ABR_ANCHORS[0] || DEFAULT_ANCHORS[1];
  const initialAnchor =
    signType === "freestanding" ? initialABR : DEFAULT_ANCHORS[1];

  const [anchor, setAnchor] = useState<AnchorSpec>(initialAnchor);
  const [anchorQty, setAnchorQty] = useState(4);
  const [anchorGauge, setAnchorGauge] = useState(200); // mm（上下間隔）
  const [anchorPitch, setAnchorPitch] = useState(160); // mm（左右間隔）
  const [edge1, setEdge1] = useState(50); // mm
  const [edge2, setEdge2] = useState(50); // mm
  const [spacing, setSpacing] = useState(120); // mm

  const initialHef =
    signType === "freestanding"
      ? (initialAnchor?.d || 27) * 20
      : initialAnchor?.hefRec || (initialAnchor?.d || 16) * 10;

  const [anchorEmbed, setAnchorEmbed] = useState(initialHef); // mm 有効埋込み長さ

  // アンカー選択肢（自立→ABR、その他→anchors）
  const anchorsForUI = useMemo(
    () => (signType === "freestanding" ? ABR_ANCHORS : anchors),
    [signType, anchors]
  );

  // 種別切替時：アンカー候補を整合させ、hef を下限以上に補正
  useEffect(() => {
    const list = anchorsForUI;
    if (!list || list.length === 0) return;
    const still = list.find((a) => a.name === anchor?.name);
    const next = still || list[0];

    if (next && next.name !== anchor?.name) setAnchor(next);

    const minHef =
      signType === "freestanding" ? next.d * 20 : next.hefRec || next.d * 10;

    setAnchorEmbed((prev) => Math.max(Number(prev) || 0, minHef));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signType, anchors]);

  // ===== プレート・基礎 =====
  const [plateB, setPlateB] = useState(0.4); // m（プレート幅）
  const [ecc, setEcc] = useState(0.05); // m
  const [soilQa, setSoilQa] = useState(150); // kPa 地盤許容
  const [mu, setMu] = useState(0.5);

  // --- 基礎形状モード（★追加） ---
  const [footShape, setFootShape] = useState<"RECT" | "L">("RECT");

  // --- 基礎外形（既存） ---
  const [footB, setFootB] = useState(0.8); // m（基礎幅：転倒方向）
  const [footD, setFootD] = useState(0.8); // m（基礎奥行：直角方向）
  const [footH, setFootH] = useState(0.8); // m（基礎の深さ・厚さ）
  const [embedDepth, setEmbedDepth] = useState(0.0); // m
  const [etaPassive, setEtaPassive] = useState(0.5); // ★受働土圧低減係数（0〜1）

  // ★追加：z を自動追従させるか（H-0.1 初期値）
  // true: H変更で z が追従 / false: z を手入力したら固定
  const [embedDepthAuto, setEmbedDepthAuto] = useState(true);

  // --- L形（片腕・帯）：帯幅 ---
  // t1：柱直下（断面図の t）
  // t2：先端側（断面図の 150以上 部分）
  const [L_t1, setLt1] = useState(0.2); // m（t1：柱直下帯幅）
  const [L_t2, setLt2] = useState(0.2); // m（t2：先端側帯幅）

  // ★追加：土の単位体積重量・土被り厚さ（基礎の土被り）
  const [soilUnitW, setSoilUnitW] = useState<number>(18); // kN/m³（上載り土）
  const [coverT, setCoverT] = useState<number>(0.3); // m（基礎天端→地盤面の土被り）

  const [concUnitW, setConcUnitW] = useState(24); // kN/m³
  const [Fc, setFc] = useState(21); // N/mm²

  // ===== 判定モード =====
  const [allowUpliftOK, setAllowUpliftOK] = useState(false); // 浮上り有でもOKにする

  // ================================
  // ★② Hが変わったら z を自動更新（H-0.1）
  // ================================
  useEffect(() => {
    if (!embedDepthAuto) return;

    const H = Math.max(0, Number(footH) || 0);
    const z0 = Math.max(0, H - 0.1);
    setEmbedDepth(z0);
  }, [footH, embedDepthAuto]);

  // ===== AI基礎最適化の目的関数 =====
  const [foundationOptMode, setFoundationOptMode] = useState("BD"); // "BD" | "VOL"

  // ===== 検定基準 =====
  const [reqFS_OT, setReqFS_OT] = useState(1.5); // 転倒
  const [reqFS_SL, setReqFS_SL] = useState(1.5); // 滑動
  const [gammaBearing, setGammaBearing] = useState(1.0); // 地耐力γ

  // ===== ⑥基礎 改善：最小追加（任意）=====
  // 受働土圧（根入れ抵抗）を使うか
  const [usePassive, setUsePassive] = useState(true);
  // 受働土圧の低減係数（0〜1）
  const [passiveEta, setPassiveEta] = useState(0.5);
  // 前面土がある前提か（掘削・法面等で無いなら false）
  const [frontAvailable, setFrontAvailable] = useState(true);

  // 浮上り時の摩擦低減：接地率 b_eff/B を使う（説明が通る）
  const [useContactRatioForFriction, setUseContactRatioForFriction] =
    useState(true);

  // ===== ベース曲げ =====
  const [plateFy, setPlateFy] = useState(235); // 板の降伏 N/mm²
  const [a_clear, setAclear] = useState(80); // mm
  const [plateT, setPlateT] = useState(16); // 採用板厚 mm（選択肢内）

  // ===== 荷重（風：分解入力）=====
  const [windV0, setWindV0] = useState(34); // 基準風速 V0 [m/s]
  const [windKz, setWindKz] = useState(1.0); // 高さ/地表面粗度等の係数（まとめ）Kz [-]
  const [windGf, setWindGf] = useState(1.0); // ガスト/突風等の係数（まとめ）Gf [-]
  const [windIw, setWindIw] = useState(1.0); // 重要度係数 Iw [-]
  const [windKd, setWindKd] = useState(1.0); // 風向係数 Kd [-]（必要なら）
  const [windKt, setWindKt] = useState(1.0); // 地形係数 Kt [-]（必要なら）

  // Cf の責任範囲を明示（最重要）
  const [cfMode, setCfMode] = useState<"SHAPE_ONLY" | "CF_INCLUDES_ALL">(
    "SHAPE_ONLY"
  );
  // ===== CfMode 切替時の安全策 =====
  // CF_INCLUDES_ALL のときは Kz/Gf/Iw/Kd/Kt を計算上 1.0 扱いにするため、
  // state も 1.0 にリセットして「値の持ち越し」を防止する
  useEffect(() => {
    if (cfMode !== "CF_INCLUDES_ALL") return;

    setWindKz((v) => (Number(v) === 1.0 ? v : 1.0));
    setWindGf((v) => (Number(v) === 1.0 ? v : 1.0));
    setWindIw((v) => (Number(v) === 1.0 ? v : 1.0));
    setWindKd((v) => (Number(v) === 1.0 ? v : 1.0));
    setWindKt((v) => (Number(v) === 1.0 ? v : 1.0));
  }, [cfMode]);

  // Cf は「形状係数」に集約（cfMode=CF_INCLUDES_ALL の場合は Kz/Gf/Iw/Kd/Kt を 1.0 扱い）
  const [shapeCf, setShapeCf] = useState(2.0);

  const [areaFactor, setAreaFactor] = useState(1.0);
  const [seismicC0, setSeismicC0] = useState(0.3);

  // 設計用水平力 Fh 入力（forceUnit 単位）※全体
  const [FhInput, setFhInput] = useState(0);

  const panelArea = width * height * areaFactor;

  // 基準速度圧 q0
  const q0 = wind_q0(windV0);

  // Cfに何を含めるかで、別係数側を無効化する（＝二重掛け防止）
  const Kz_eff = cfMode === "CF_INCLUDES_ALL" ? 1.0 : windKz;
  const Gf_eff = cfMode === "CF_INCLUDES_ALL" ? 1.0 : windGf;
  const Iw_eff = cfMode === "CF_INCLUDES_ALL" ? 1.0 : windIw;
  const Kd_eff = cfMode === "CF_INCLUDES_ALL" ? 1.0 : windKd;
  const Kt_eff = cfMode === "CF_INCLUDES_ALL" ? 1.0 : windKt;

  // 設計速度圧 qz
  const qz = q0 * Kz_eff * Gf_eff * Iw_eff * Kd_eff * Kt_eff;

  // 看板全体：風力
  const Fw_total = qz * shapeCf * panelArea; // N

  const Wself_total = panelKg * G; // N

  const nCol_raw = Math.max(1, Math.floor(Number(postQty) || 1));

  // ★連結なし（OFF）の場合：荷重は均等分担できない前提 → 1本扱い
  const nCol = hasInterPostConnection ? nCol_raw : 1;

  // 風・地震からの「自動」水平力（全体）
  const Fh_auto_total = useMemo(
    () =>
      signType === "freestanding"
        ? Math.max(Fw_total, Wself_total * seismicC0)
        : Fw_total + Wself_total * seismicC0,
    [signType, Fw_total, Wself_total, seismicC0]
  );

  // 入力Fh（forceUnit に応じて N に変換）※全体
  const Fh_manual_total_N = useMemo(() => {
    const v = Math.max(0, FhInput);
    if (forceUnit === "kgf") return v * G;
    return v;
  }, [FhInput, forceUnit]);

  // 設計に用いる Fh（全体）：入力値 > 0 のとき優先、0 のとき自動値
  const Fh_total = useMemo(
    () => (Fh_manual_total_N > 0 ? Fh_manual_total_N : Fh_auto_total),
    [Fh_manual_total_N, Fh_auto_total]
  );

  // ★設計に用いる Fh（1本あたり）
  const Fh = Fh_total / nCol;

  // モーメント（1本あたり）
  const M = useMemo(
    () =>
      signType === "freestanding"
        ? Fh * cgHeight
        : signType === "projecting"
        ? Fh * 0.8
        : Fh * 0.1,
    [signType, Fh, cgHeight]
  );

  // ===== 断面特性 =====
  const active =
    candidates.find((s) => s.name === sectionName) || candidates[0];
  const Zx = (active?.Zx_cm3 ?? 50) * 1e-6; // m³
  const Zy = (active?.Zy_cm3 ?? 50) * 1e-6; // m³
  const ix = (active?.ix_cm ?? 3) * 0.01; // m
  const iy = (active?.iy_cm ?? 3) * 0.01; // m
  const Z_axis = bendAxis === "x" ? Zx : Zy;
  const r = bendAxis === "x" ? ix : iy;

  // ===== 部材検定（1本あたり）=====
  const sigma = M / Math.max(Z_axis, 1e-12) / 1e6; // N/mm²
  const sigma_allow = sigmaAllow(Fy);
  const etaColumn = sigma / sigma_allow;
  const lambda = (K * L) / Math.max(r, 1e-6);
  const slenderOK = lambda <= 200;

  // ===== アンカー Σy² 配分（1本あたりMで検定）=====
  const { list: T_each_list } = useMemo(
    () => computeAnchorTensions(M, anchorGauge, anchorPitch),
    [M, anchorGauge, anchorPitch]
  );
  const T_each = T_each_list;
  const Tmax = Math.max(...T_each.map((o) => Math.max(0, o.T)), 0);

  // ★簡易版：アンカー配置モデルは 2×2（4本）固定
  const ANCHOR_CALC_QTY = Math.max(2, Math.floor(Number(anchorQty) || 4));
  const V_anchor = Fh / ANCHOR_CALC_QTY;

  const d = anchor.d;
  const minEdge = anchor.min_e ?? Math.round(1.5 * d);
  const minSpace = anchor.min_s ?? Math.round(3 * d);
  const edge1OK = edge1 >= minEdge;
  const edge2OK = signType === "projecting" ? true : edge2 >= minEdge;
  const spacingOK = spacing >= minSpace;
  const edgeOK = edge1OK && edge2OK;

  // アンカー：コンクリート側引張耐力（新：安全側）
  const hef = Number(anchorEmbed) || 0;
  const FcNum = Number(Fc) || 0;

  const Ta_conc =
    FcNum > 0 && hef > 0
      ? ANCHOR_CONC.k *
        Math.sqrt(FcNum) *
        Math.pow(hef, 1.5) *
        ANCHOR_CONC.phi *
        ANCHOR_CONC.psiEdge *
        ANCHOR_CONC.psiCrack
      : 0;

  const Ta_eff = Math.min(anchor.Ta, Ta_conc);
  const Va_eff = anchor.Va;

  const etaAnchorSteel = anchor.Ta > 0 ? Tmax / anchor.Ta : Infinity;
  const etaAnchorConc = Ta_conc > 0 ? Tmax / Ta_conc : Infinity;
  const etaAnchorLinear =
    (Ta_eff > 0 ? Tmax / Ta_eff : Infinity) +
    (Va_eff > 0 ? V_anchor / Va_eff : 0);

  // hef 要件：自立＝20d、その他＝hefRec（無ければ10d）
  const hefReq =
    signType === "freestanding"
      ? anchor.d * 20
      : anchor.hefRec || anchor.d * 10;
  const hefOK = anchorEmbed >= hefReq;

  // ===== ベースプレート曲げ（1本あたり）=====
  const a_mm = Math.max(10, a_clear);
  const s_mm = Math.max(40, anchorPitch);
  const T_row = Math.max(...T_each.filter((o) => o.y > 0).map((o) => o.T), 0);
  const t_req = computePlateThickness(T_row, a_mm, s_mm, plateFy);
  const plateOK = plateT >= t_req;

  // ===== 基礎判定（通常計算・AI最適化で完全共有）=====
  // ※(D) 土被り重量 + 根入れ抵抗（受働土圧）を簡易で加味
  function evalFoundation(B: number, D: number, H: number) {
    // --- L型対応：有効面積 A を定義（RECT：B*D、L：帯L＝B*t + D*t − t*t） ---
    const t1 = Math.max(0, Number(L_t1) || 0);
    const t2 = Math.max(0, Number(L_t2) || 0);

    // --- L形（片腕・帯）：平面有効面積 ---
    // A = B·t1 + D·t2 − t1·t2（重なり控除）
    const A =
      footShape === "L"
        ? Math.max(B * t1 + D * t2 - t1 * t2, 1e-9)
        : Math.max(B * D, 1e-9);

    // 偏心・接地圧の簡易評価（Bモード：幅Bで評価）
    // 1本あたりの鉛直（看板自重）は外側スコープの Wself_perCol を参照

    // 1) 重量用の有効面積：L形は A_weight（矩形はB*D）
    const A_weight =
      footShape === "L"
        ? Math.max(B * t1 + D * t2 - t1 * t2, 1e-9)
        : Math.max(B * D, 1e-9);

    const Wconc = concUnitW * 1000 * (A_weight * H); // N（kN/m3→N/m3）
    const Wcover = soilUnitW * 1000 * (A_weight * coverT); // N（土被り）
    const N = Wconc + Wcover + Wself_perCol; // 合計鉛直力 N

    // 2) 偏心（符号は不要：大きさで判定）
    const e = Math.abs(M) / Math.max(N, 1e-9); // m
    const e_lim = B / 6; // ★Bモード：常にB/6

    // 3) 接地状態判定（B方向）
    let sigma_max = Infinity;
    let sigma_min = 0;
    let noUplift = false;

    let contactMode: "full" | "partial" | "none" = "full";
    let b_eff = B; // 有効接地幅（B方向）

    if (e <= e_lim) {
      contactMode = "full";
      b_eff = B;
    } else if (e < B / 2) {
      contactMode = "partial";
      b_eff = Math.max(3 * (B / 2 - e), 0); // 三角分布の等価幅
    } else {
      contactMode = "none";
      b_eff = 0;
    }

    // 4) 接地圧の評価は B×D を基準に統一（B方向の片圧モデルと整合）
    const A_full = Math.max(B * D, 1e-9);
    const A_contact = Math.max(b_eff * D, 1e-9);

    if (contactMode === "full") {
      const sigma_avg_full = N / A_full; // N/m²
      sigma_max = sigma_avg_full * (1 + (6 * e) / Math.max(B, 1e-9));
      sigma_min = sigma_avg_full * (1 - (6 * e) / Math.max(B, 1e-9));
      noUplift = sigma_min >= 0;
    } else if (contactMode === "partial") {
      sigma_max = (2 * N) / A_contact; // N/m²
      sigma_min = 0;
      noUplift = false;
    } else {
      sigma_max = Infinity;
      sigma_min = 0;
      noUplift = false;
    }

    const qa_allow_soil = soilQa / Math.max(gammaBearing, 1e-9); // kPa
    const qa_allow_conc = 0.25 * Fc * 1000; // kPa（0.25Fc）
    const qa_allow_final = Math.min(qa_allow_soil, qa_allow_conc);
    const bearingOK = isFinite(sigma_max)
      ? sigma_max / 1000 <= qa_allow_final
      : false;

    // ===== 根入れ抵抗（受働土圧）=====
    // 受働土圧合力 Pp = 1/2 * Kp * γ * D * z^2
    // ここで γ=soilUnitW (kN/m3) を N/m3 に変換
    const z = Math.max(0, Number(embedDepth) || 0); // m
    const gammaN = soilUnitW * 1000; // N/m3
    // 受働土圧（低減係数 ηp を考慮）
    const Pp_raw = z > 0 ? 0.5 * PASSIVE_SOIL.Kp * gammaN * D * z * z : 0; // N

    const Pp = Pp_raw * etaPassive; // ★低減後 受働土圧
    const M_passive = z > 0 ? Pp * (z / 3) : 0; // N·m

    // ===== 転倒 =====
    // 抵抗モーメント Mr = N*(B/2 - e) + M_passive（浮上り時はB/2-eが小さくなる）
    const leverArm_OT = Math.max(B / 2 - e, 0); // ★追加：FS計算と同じレバーアーム
    const MrN = N * leverArm_OT;
    const Mr = MrN + M_passive;
    const FS_OT = Mr / Math.max(Math.abs(M), 1e-9);

    const OT_OK = allowUpliftOK
      ? FS_OT >= reqFS_OT
      : FS_OT >= reqFS_OT && noUplift;

    // ===== 滑動（受働抵抗を加味）=====
    // 浮上り時の有効鉛直力は「接地率」で低減（0.5固定より説明が通る）
    const contactRatio = B > 0 ? Math.min(Math.max(b_eff / B, 0), 1) : 0;
    const N_eff = N * contactRatio;

    const R_slide = mu * N_eff + Pp; // N（摩擦 + 受働）
    const FS_SL = R_slide / Math.max(Fh, 1e-9);
    const SL_OK = FS_SL >= reqFS_SL;

    // ===== 総合判定 =====
    const ok = bearingOK && OT_OK && SL_OK;

    return {
      ok,
      N,
      e,
      sigma_max,
      sigma_min,
      noUplift,
      qa_allow_soil,
      qa_allow_conc,
      qa_allow_final,
      bearingOK,
      leverArm_OT,
      FS_OT,
      OT_OK,
      FS_SL,
      SL_OK,

      // ★改善：滑動の注記（接地長連動を明示）
      slideNote: noUplift
        ? "滑動: N_eff = N（全面圧縮）"
        : `滑動: N_eff = N×接地率（接地率 = b_eff/B = ${contactRatio.toFixed(
            2
          )}、片圧）`,

      volume: A * H,
      areaBD: A,
      B_eff: B,
      B,
      D,
      H,
      Pp,
      Pp_raw,
      M_passive,
      z,
      R_slide,
    };
  }
  // ===== 基礎（1本あたり：共通関数の結果を使用）=====
  const Wself_perCol = Wself_total / nCol;

  const fnd =
    signType === "freestanding" ? evalFoundation(footB, footD, footH) : null;

  const N_foundation = fnd?.N ?? 0;
  const e_f = fnd?.e ?? 0;
  const sigma_max = fnd?.sigma_max ?? 0;
  const sigma_min = fnd?.sigma_min ?? 0;
  const noUplift = fnd?.noUplift ?? false;

  const qa_allow_soil =
    fnd?.qa_allow_soil ?? soilQa / Math.max(gammaBearing, 1e-9);
  const qa_allow_conc = fnd?.qa_allow_conc ?? 0.25 * Fc * 1000;
  const qa_allow_final =
    fnd?.qa_allow_final ?? Math.min(qa_allow_soil, qa_allow_conc);

  const bearingOK = fnd?.bearingOK ?? true;

  // ===== 転倒：浮上り時に過大表示しないFS_OT（共通）=====
  const leverArm_OT = fnd?.leverArm_OT ?? footB / 2;
  const FS_OT = fnd?.FS_OT ?? 0;

  // 判定モード切替（共通）
  const OT_OK = fnd?.OT_OK ?? true;

  // ===== 滑動（共通）=====
  const FS_SL = fnd?.FS_SL ?? 0;
  const SL_OK = fnd?.SL_OK ?? true;

  // ★追加：滑動の注記（表示用）
  const fsSlAssumptionNote = fnd?.slideNote ?? "";

  // 根入れ抵抗（表示用）
  const Pp = fnd?.Pp ?? 0;
  const Pp_raw = fnd?.Pp_raw ?? 0;
  const M_passive = fnd?.M_passive ?? 0;
  const R_slide = fnd?.R_slide ?? 0;
  const z_embed = fnd?.z ?? 0;

  /* ===== ★追加：結果欄表示用（基礎形状・面積式）===== */
  const foundationShapeText =
    signType === "freestanding"
      ? footShape === "L"
        ? `L形基礎（片腕・帯：t1=${Number(L_t1).toFixed(2)}m, t2=${Number(
            L_t2
          ).toFixed(2)}m）`
        : "矩形基礎"
      : "";

  const foundationAreaFormula =
    signType === "freestanding" && footShape === "L"
      ? `A = B·t1 + D·t2 − t1·t2 = ${footB.toFixed(2)}×${Number(L_t1).toFixed(
          2
        )} + ${footD.toFixed(2)}×${Number(L_t2).toFixed(2)} − ${Number(
          L_t1
        ).toFixed(2)}×${Number(L_t2).toFixed(2)} = ${(fnd?.areaBD ?? 0).toFixed(
          3
        )} m²`
      : `A = B×D = ${(fnd?.areaBD ?? 0).toFixed(3)} m²`;

  // ===== 基礎総合判定 =====
  const foundationOK = signType !== "freestanding" || (fnd?.ok ?? false);

  // FS_OT の注記用（結果欄で使う）
  // ※ evalFoundation の実装（leverArm_OT = max(B/2 - e, 0)）と整合
  const fsOtAssumptionNote =
    signType === "freestanding"
      ? noUplift
        ? "レバーアーム = B/2 − e（全面圧縮）"
        : "レバーアーム = max(B/2 − e, 0)（片圧）"
      : "";
  // ===== 総合 =====
  const overallOK =
    etaColumn < 1 &&
    slenderOK &&
    etaAnchorLinear < 1 &&
    foundationOK &&
    edgeOK &&
    spacingOK &&
    plateOK &&
    hefOK;

  // What-if（風）※Fh入力とは別に、純粋な風による η を可視化（1本あたりで表示）
  const whatIf = useMemo(() => {
    const arr: { V: number; eta: number }[] = [];
    for (let V = 20; V <= 50; V += 2) {
      const qv = windPressure(V, {
        cfMode,
        windKz,
        windGf,
        windIw,
        windKd,
        windKt,
      });
      const FwV_total = qv * shapeCf * panelArea;
      const FhV_total =
        signType === "freestanding"
          ? Math.max(FwV_total, Wself_total * seismicC0)
          : FwV_total + Wself_total * seismicC0;

      const FhV = FhV_total / nCol;
      const MV = signType === "freestanding" ? FhV * cgHeight : FhV * 0.8;
      const sV = MV / Math.max(Z_axis, 1e-12) / 1e6;
      arr.push({ V, eta: sV / sigma_allow });
    }
    return arr;
  }, [
    shapeCf,
    panelArea,
    signType,
    Wself_total,
    seismicC0,
    cgHeight,
    Z_axis,
    sigma_allow,
    nCol,
  ]);

  // ===== JSON IO (DB) =====
  function handleImportAnchors(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const json = JSON.parse(String(r.result));
        if (!Array.isArray(json)) throw new Error("配列JSON");
        const rows: AnchorSpec[] = [];
        for (const o of json) {
          if (
            o &&
            typeof o === "object" &&
            typeof o.name === "string" &&
            Number.isFinite(o.d) &&
            Number.isFinite(o.Ta) &&
            Number.isFinite(o.Va)
          ) {
            rows.push({
              name: o.name,
              d: o.d,
              Ta: o.Ta,
              Va: o.Va,
              min_e: Number.isFinite(o.min_e) ? o.min_e : undefined,
              min_s: Number.isFinite(o.min_s) ? o.min_s : undefined,
              hefRec: Number.isFinite(o.hefRec) ? o.hefRec : undefined,
            });
          }
        }
        if (rows.length === 0) throw new Error("有効行なし");
        setAnchors(rows);

        // 自立は ABR 固定のため、ここでアンカー本体は切替えない（袖/壁のみ反映）
        if (signType !== "freestanding") {
          setAnchor(rows[0]);
          setAnchorEmbed(rows[0].hefRec || rows[0].d * 10);
        }

        alert(
          `アンカーDB ${rows.length}件\n${
            signType === "freestanding"
              ? "※自立看板はABR固定のため、読込DBは袖/壁付でのみ使用します。"
              : ""
          }`
        );
      } catch (e: any) {
        alert("読込エラー:" + (e?.message || String(e)));
      }
    };
    r.readAsText(file);
  }
  function handleExportAnchors() {
    const blob = new Blob([JSON.stringify(anchors, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "anchors.json";
    a.click();
  }
  function handleImportSections(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const json = JSON.parse(String(r.result));
        if (!Array.isArray(json)) throw new Error("配列JSON");
        const rows = json.filter(
          (o) =>
            o &&
            typeof o === "object" &&
            typeof o.family === "string" &&
            typeof o.name === "string"
        );
        if (rows.length === 0) throw new Error("有効行なし");
        setSections(rows);
        setFamily(rows[0].family);
        setSectionName(rows[0].name);
        alert(`鋼材DB ${rows.length}件`);
      } catch (e: any) {
        alert("読込エラー:" + (e?.message || String(e)));
      }
    };
    r.readAsText(file);
  }
  function handleExportSections() {
    const blob = new Blob([JSON.stringify(sections, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sections_db.json";
    a.click();
  }

  // ===== 設定入出力 =====
  const hiddenCfgInputRef = useRef<HTMLInputElement | null>(null);
  function buildConfig() {
    return {
      __app: "SignWizard",
      __ver: "B-Fc36-ABR-20D-PLT-SELECT-PASSIVE",
      forceUnit,
      pdfSigmaDigits,
      pdfMDigits,
      pdfRoundingMode,
      signType,
      width,
      height,
      panelKg,
      cgHeight,
      windV0,
      shapeCf,
      areaFactor,
      seismicC0,
      sections,
      family,
      sectionName,
      bendAxis,
      Fy,
      K,
      L,
      postQty,
      hasInterPostConnection, // ★追加：柱間連結

      anchors,
      anchorName: anchor?.name,
      anchorQty,
      anchorGauge,
      anchorPitch,
      edge1,
      edge2,
      spacing,
      plateFy,
      a_clear,
      plateT,
      plateB,
      ecc,
      soilQa,
      mu,
      footB,
      footD,
      footH,
      embedDepth,
      etaPassive, // ★追加
      concUnitW,
      reqFS_OT,
      reqFS_SL,
      gammaBearing,
      Fc,
      anchorEmbed,
      FhInput,

      projectName,
      projectNo,
      rev,
      author,
      checker,
      approver,
      plateD,
      holeClearance,
      finishSpec,
      concSpec,
      lawRef,
      siteNotes,

      allowUpliftOK,
      foundationOptMode,
    };
  }
  function applyConfig(cfg: any) {
    if (!cfg || typeof cfg !== "object") {
      throw new Error("設定オブジェクト不正");
    }

    if (typeof cfg.allowUpliftOK === "boolean") {
      setAllowUpliftOK(cfg.allowUpliftOK);
    }
    if (cfg.foundationOptMode === "BD" || cfg.foundationOptMode === "VOL") {
      setFoundationOptMode(cfg.foundationOptMode);
    }

    const num = (v: any) => Number.isFinite(v);
    const str = (v: any) => typeof v === "string";
    const arr = (a: any) => Array.isArray(a) && a.length > 0;

    const signTypeFromCfg = str(cfg.signType) ? cfg.signType : signType;

    if (str(cfg.forceUnit)) setForceUnit(cfg.forceUnit);
    if (num(cfg.pdfSigmaDigits)) setPdfSigmaDigits(cfg.pdfSigmaDigits);
    if (num(cfg.pdfMDigits)) setPdfMDigits(cfg.pdfMDigits);
    if (str(cfg.pdfRoundingMode)) setPdfRoundingMode(cfg.pdfRoundingMode);
    if (str(cfg.signType)) setSignType(cfg.signType);
    if (num(cfg.width)) setWidth(cfg.width);
    if (num(cfg.height)) setHeight(cfg.height);
    if (num(cfg.panelKg)) setPanelKg(cfg.panelKg);
    if (num(cfg.cgHeight)) setCgHeight(cfg.cgHeight);
    // 風速（保存キー：windV0）※旧キー V0 も互換で拾う
    if (num(cfg.windV0)) setWindV0(cfg.windV0);
    else if (num(cfg.V0)) setWindV0(cfg.V0);
    if (num(cfg.shapeCf)) setShapeCf(cfg.shapeCf);
    if (num(cfg.areaFactor)) setAreaFactor(cfg.areaFactor);
    if (num(cfg.seismicC0)) setSeismicC0(cfg.seismicC0);
    if (arr(cfg.sections)) setSections(cfg.sections);
    if (str(cfg.family)) setFamily(cfg.family);
    if (str(cfg.sectionName)) setSectionName(cfg.sectionName);
    if (str(cfg.bendAxis)) setBendAxis(cfg.bendAxis);
    if (num(cfg.Fy)) setFy(cfg.Fy);
    if (num(cfg.K)) setK(cfg.K);
    if (num(cfg.L)) setL(cfg.L);

    if (num(cfg.postQty)) setPostQty(Math.max(1, Math.floor(cfg.postQty)));
    if (typeof cfg.hasInterPostConnection === "boolean")
      setHasInterPostConnection(cfg.hasInterPostConnection);

    // 非自立アンカーDB
    if (arr(cfg.anchors)) setAnchors(cfg.anchors);

    // アンカー選定（自立は ABR 優先）
    if (str(cfg.anchorName)) {
      const list =
        signTypeFromCfg === "freestanding"
          ? ABR_ANCHORS
          : Array.isArray(cfg.anchors)
          ? cfg.anchors
          : anchors;

      const pick =
        list.find((a: AnchorSpec) => a.name === cfg.anchorName) || list[0];
      if (pick) {
        setAnchor(pick);
        const minHef =
          signTypeFromCfg === "freestanding"
            ? pick.d * 20
            : pick.hefRec || pick.d * 10;
        setAnchorEmbed(minHef);
      }
    }

    if (num(cfg.anchorQty)) setAnchorQty(cfg.anchorQty);
    if (num(cfg.anchorGauge)) setAnchorGauge(cfg.anchorGauge);
    if (num(cfg.anchorPitch)) setAnchorPitch(cfg.anchorPitch);
    if (num(cfg.edge1)) setEdge1(cfg.edge1);
    if (num(cfg.edge2)) setEdge2(cfg.edge2);
    if (num(cfg.spacing)) setSpacing(cfg.spacing);
    if (num(cfg.plateFy)) setPlateFy(cfg.plateFy);
    if (num(cfg.a_clear)) setAclear(cfg.a_clear);

    // plateT は選択肢に丸め
    if (num(cfg.plateT)) setPlateT(snapPlateT(cfg.plateT));

    if (num(cfg.plateB)) setPlateB(cfg.plateB);
    if (num(cfg.ecc)) setEcc(cfg.ecc);
    if (num(cfg.soilQa)) setSoilQa(cfg.soilQa);
    if (num(cfg.mu)) setMu(cfg.mu);
    if (num(cfg.footB)) setFootB(cfg.footB);
    if (num(cfg.footD)) setFootD(cfg.footD);
    if (num(cfg.footH)) setFootH(cfg.footH);
    if (num(cfg.embedDepth)) setEmbedDepth(cfg.embedDepth);
    // ★追加：受働土圧低減係数
    if (num(cfg.etaPassive)) {
      setEtaPassive(Math.min(Math.max(cfg.etaPassive, 0.1), 1.0));
    }
    if (num(cfg.concUnitW)) setConcUnitW(cfg.concUnitW);
    if (num(cfg.reqFS_OT)) setReqFS_OT(cfg.reqFS_OT);
    if (num(cfg.reqFS_SL)) setReqFS_SL(cfg.reqFS_SL);
    if (num(cfg.gammaBearing)) setGammaBearing(cfg.gammaBearing);
    if (num(cfg.Fc)) setFc(cfg.Fc);

    if (num(cfg.anchorEmbed)) {
      const minHef =
        signTypeFromCfg === "freestanding"
          ? (anchor?.d || 27) * 20
          : anchor?.hefRec || (anchor?.d || 16) * 10;
      setAnchorEmbed(Math.max(minHef, cfg.anchorEmbed));
    }

    if (num(cfg.FhInput)) setFhInput(cfg.FhInput);

    // ===== 指示書（PDF）用 =====
    if (str(cfg.projectName)) setProjectName(cfg.projectName);
    if (str(cfg.projectNo)) setProjectNo(cfg.projectNo);
    if (str(cfg.rev)) setRev(cfg.rev);
    if (str(cfg.author)) setAuthor(cfg.author);
    if (str(cfg.checker)) setChecker(cfg.checker);
    if (str(cfg.approver)) setApprover(cfg.approver);

    if (num(cfg.plateD)) setPlateD(cfg.plateD);
    if (num(cfg.holeClearance)) setHoleClearance(cfg.holeClearance);
    if (str(cfg.finishSpec)) setFinishSpec(cfg.finishSpec);
    if (str(cfg.concSpec)) setConcSpec(cfg.concSpec);
    if (str(cfg.lawRef)) setLawRef(cfg.lawRef);
    if (str(cfg.siteNotes)) setSiteNotes(cfg.siteNotes);
  }
  function handleExportConfig() {
    const blob = new Blob([JSON.stringify(buildConfig(), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sign_config.json";
    a.click();
  }
  function handleImportConfig(file: File) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const cfg = JSON.parse(String(r.result));
        applyConfig(cfg);
        alert("設定を読み込みました");
      } catch (e: any) {
        alert("設定読込エラー: " + (e?.message || String(e)));
      }
    };
    r.readAsText(file);
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.altKey && ev.shiftKey && (ev.key === "S" || ev.key === "s")) {
        ev.preventDefault();
        handleExportConfig();
      }
      if (ev.altKey && ev.shiftKey && (ev.key === "O" || ev.key === "o")) {
        ev.preventDefault();
        const el = hiddenCfgInputRef.current;
        if (el) {
          el.value = "";
          el.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadPDF() {
    const [{ jsPDF }, html2canvasMod] = await Promise.all([
      import("jspdf").then((m) => ({
        jsPDF: (m as any).jsPDF || (m as any).default,
      })),
      import("html2canvas"),
    ]);
    const html2canvas: any = (html2canvasMod as any).default || html2canvasMod;

    const sigmaPdfStr = fmtByMode(
      sigma,
      pdfSigmaDigits,
      pdfRoundingMode,
      " N/mm²"
    );
    const MpdfStr =
      forceUnit === "kgf"
        ? fmtByMode(toKgf(M), pdfMDigits, pdfRoundingMode, " kgf·m")
        : fmtByMode(M, pdfMDigits, pdfRoundingMode, " N·m");

    const Fh_design_disp = showF(Fh, forceUnit); // 1本あたり
    const Fh_total_disp = showF(Fh_total, forceUnit); // 全体
    const Fh_auto_disp = showF(Fh_auto_total, forceUnit); // 全体自動
    const Fh_in_disp =
      FhInput > 0
        ? `${FhInput.toFixed(1)} ${forceUnit}（入力・全体）`
        : "0（自動使用）";

    const familyJP = FAMILY_JP_MAP[family] || family;
    const e_ratio = e_f / (footB || 1);

    const hefLabel =
      signType === "freestanding" ? `20d=${hefReq}mm` : `推奨=${hefReq}mm`;

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    container.style.width = "794px";

    const escapeHtml = (s: any) => {
      const str = String(s ?? "");
      return str
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    };
    const otModeLabel = noUplift
      ? "全面圧縮"
      : allowUpliftOK
      ? "浮上り許容設計"
      : "浮上り不可設定";

    const fsOtLabelForPdf = `${fsOtAssumptionNote}・${otModeLabel}`;
    const upliftNoteForPdf = allowUpliftOK
      ? "浮上り許容設計：接地圧が片圧（三角分布）となる前提を含む。施工条件・地盤条件の変動に対する余裕を別途確認すること。"
      : "浮上り不可設定：浮上りが生じる場合はNG。基礎寸法・根入れ・荷重条件の見直しを行うこと。";

    container.innerHTML = `
    <style>
      .page{
        width:794px;
        padding:18px;
        background:#fff;
        box-sizing:border-box;
        font-family:ui-sans-serif;
        line-height:1.25;
      }
      h1{font-size:14px;margin:0 0 4px}
      h2{font-size:11px;margin:6px 0 3px}
      h3{font-size:10px;margin:6px 0 3px}
      table{border-collapse:collapse;width:100%;font-size:9.5px}
      th,td{
        border:1px solid #ddd;
        padding:2px 4px;
        text-align:left;
        vertical-align:top;
      }
      .muted{color:#666;font-size:9px}
      .ok{color:#065f46}
      .ng{color:#9b1c1c}
    </style>
    <section class='page'>
      <h1>サイン構造計算(簡易版) — 検定サマリ</h1>
      <div class='muted'>力=${forceUnit} / M=${
      forceUnit === "kgf" ? "kgf·m" : "N·m"
    }</div>

      <h2>案件情報（施工・製作 指示）</h2>
      <table>
        <tr>
          <th style="width:18%">工事名</th>
          <td style="width:32%">${projectName || "—"}</td>
          <th style="width:18%">案件番号</th>
          <td style="width:32%">${projectNo || "—"}</td>
        </tr>
        <tr>
          <th>Rev</th>
          <td>${rev || "—"}</td>
          <th>作成日</th>
          <td>${new Date().toLocaleDateString()}</td>
        </tr>
        <tr>
          <th>作成</th>
          <td>${author || "—"}</td>
          <th>確認</th>
          <td>${checker || "—"}</td>
        </tr>
        <tr>
          <th>承認</th>
          <td colspan="3">${approver || "—"}</td>
        </tr>
      </table>

      <h2>1) 主要入力</h2>
      <table>
        <tr>
          <th>種別</th><td>${signType}</td>
          <th>W×H</th><td>${width}×${height} m</td>
          <th>風速</th><td>${windV0} m/s</td>
        </tr>
        <tr>
          <th>柱本数</th><td>${nCol} 本</td>
          <th>水平力 Fh（全体）</th><td colspan='3'>${Fh_total_disp}</td>
        </tr>
        <tr>
          <th>柱間連結</th>
          <td colspan='5'>
            ${
              hasInterPostConnection
                ? "あり（均等分担前提）"
                : "なし（計算は安全側に1本柱扱い）"
            }
          </td>
        </tr>
        <tr>
          <th>水平力 Fh（1本あたり）</th>
          <td colspan='5'>
            設計Fh=${Fh_design_disp}（入力Fh=${Fh_in_disp}, 自動Fh（全体）=${Fh_auto_disp}）
          </td>
        </tr>
        <tr>
          <th>部材</th>
          <td colspan='5'>
            ${familyJP} / ${sectionName} / ${bendAxis.toUpperCase()}曲げ,
            Fy=${Fy} N/mm², K=${K}, L=${L} m
          </td>
        </tr>
        <tr>
          <th>アンカー</th>
          <td colspan='5'>
            ${anchor.name} × ${anchorQty}
            （d=${anchor.d}mm, Ta=${anchor.Ta}, Va=${anchor.Va},
             hef採用=${anchorEmbed}mm, 要件：${hefLabel}）
            縦間隔=${anchorGauge}mm, 横間隔=${anchorPitch}mm
          </td>
        </tr>
        <tr>
          <th>プレート</th>
          <td colspan='5'>
            柱〜アンカー芯 a=${a_mm} mm, 列間隔=${s_mm} mm,
            採用t=${plateT} mm（t_req=${fmt(t_req, " mm", 1)}）
          </td>
        </tr>
        <tr>
          <th>基礎B×D×H（1本あたり）</th><td>${footB}×${footD}×${footH} m</td>
          <th>根入れ深さ</th><td>z=${fmt(z_embed, " m", 2)}</td>
          <th>地耐力・Fc</th><td>qa=${soilQa} kPa, Fc=${Fc}</td>
        </tr>
      </table>

      <h2>2) 部材・アンカー（1本あたり）</h2>
      <table>
        <tr>
          <th>Fh(設計/本)</th><td>${Fh_design_disp}</td>
          <th>M</th><td>${MpdfStr}</td>
        </tr>
        <tr>
          <th>σ</th><td>${sigmaPdfStr}</td>
          <th>η部材</th>
          <td>
            ${fmt(etaColumn, "", 3)}
            （<span class='${etaColumn < 1 ? "ok" : "ng"}'>${
      etaColumn < 1 ? "OK" : "NG"
    }</span>）
          </td>
        </tr>
        <tr>
          <th>λ</th><td>${fmt(lambda, "", 0)} / 200</td>
          <th>細長比判定</th>
          <td><span class='${slenderOK ? "ok" : "ng"}'>${
      slenderOK ? "OK" : "NG"
    }</span></td>
        </tr>
        <tr>
          <th>アンカー鋼材 η</th>
          <td>${fmt(etaAnchorSteel, "", 3)}</td>
          <th>コンクリ側 η</th>
          <td>${fmt(etaAnchorConc, "", 3)}</td>
        </tr>
        <tr>
          <th>ｱﾝｶｰ合成 η(linear)</th>
          <td colspan='3'>
            ${fmt(etaAnchorLinear, "", 3)}
            （<span class='${etaAnchorLinear < 1 ? "ok" : "ng"}'>${
      etaAnchorLinear < 1 ? "OK" : "NG"
    }</span>）
          </td>
        </tr>
        <tr>
          <th>埋込み長さ hef</th>
          <td colspan='3'>
            採用=${anchorEmbed}mm, 要件=${hefLabel} →
            <span class='${hefOK ? "ok" : "ng"}'>${hefOK ? "OK" : "NG"}</span>
          </td>
        </tr>
        <tr>
          <th>ベースt</th>
          <td colspan='3'>
            ${plateT}mm ≥ ${fmt(t_req, " mm", 1)} →
            <span class='${plateOK ? "ok" : "ng"}'>${
      plateOK ? "OK" : "NG"
    }</span>
          </td>
        </tr>
      </table>

      <h2>3) 基礎（1本あたり：転倒・滑動・支持力）</h2>
      <table>
        <tr>
          <th>N(基礎＋土被り＋看板自重/本)</th><td>${showF(
            N_foundation,
            forceUnit
          )}</td>
          <th>偏心 e / B</th>
          <td>e=${fmt(e_f, " m", 3)}, e/B=${fmt(e_ratio, "", 3)}</td>
        </tr>
        <tr>
          <th>σmax/σmin</th>
          <td>${fmt(sigma_max / 1000, " kPa")} / ${fmt(
      sigma_min / 1000,
      " kPa"
    )}</td>
          <th>地耐力(soil/conc)</th>
          <td>${qa_allow_soil.toFixed(0)} / ${qa_allow_conc.toFixed(
      0
    )} kPa（採用=${qa_allow_final.toFixed(0)}）</td>
        </tr>
        <tr>
          <th>根入れ抵抗（簡易）</th>
          <td>
  Pp=${showF(Pp, forceUnit)}
  <span class="muted">
    （ηp=${etaPassive.toFixed(2)} →
     Pp_raw=${showF(Pp_raw, forceUnit)}）
  </span>
</td>
          <th>抵抗ﾓｰﾒﾝﾄ</th>
          <td>Mpass=${
            forceUnit === "kgf"
              ? fmt(toKgf(M_passive), " kgf·m", 1)
              : fmt(M_passive, " N·m", 1)
          }</td>
        </tr>
        <tr>
        <th>転倒 FS</th>
        <td>${fmt(FS_OT, "", 2)} ≥ ${reqFS_OT}（${fsOtLabelForPdf}）</td>
        <th>判定</th>
        <td><span class='${OT_OK ? "ok" : "ng"}'>${
      OT_OK ? "OK" : "NG"
    }</span></td>
      </tr>

      <tr>
      <th>滑動 FS</th>
      <td>${fmt(FS_SL, "", 2)} ≥ ${reqFS_SL}${
      fsSlAssumptionNote ? `（${escapeHtml(fsSlAssumptionNote)}）` : ""
    }</td>
      <th>判定</th>
      <td><span class='${SL_OK ? "ok" : "ng"}'>${
      SL_OK ? "OK" : "NG"
    }</span></td>
    </tr>    
        <tr>
          <th>支持力</th>
          <td>σmax=${fmt(sigma_max / 1000, " kPa")} ≤ ${qa_allow_final.toFixed(
      0
    )} kPa</td>
          <th>判定</th>
          <td><span class='${bearingOK ? "ok" : "ng"}'>${
      bearingOK ? "OK" : "NG"
    }</span></td>
        </tr>
      </table>

      <h2>指示書（施工・製作）</h2>
      <table>
        <tr><th>仕上げ</th><td colspan="5">${
          escapeHtml(finishSpec) || "—"
        }</td></tr>
        <tr>
          <th>孔径ルール</th>
          <td colspan="5">
            孔径 = d + ${Number(holeClearance).toFixed(0)} mm（クリアランス）
            ／ 現在アンカー d=${anchor?.d ?? "—"} mm → 孔径目安=${
      anchor?.d ? (anchor.d + Number(holeClearance)).toFixed(0) : "—"
    } mm
          </td>
        </tr>
        <tr>
          <th>ベースプレート</th>
          <td colspan="5">
            寸法：Bp=${fmt(plateB, " m", 2)} × Dp=${fmt(plateD, " m", 2)}
            ／ 板厚 t=${plateT} mm（採用）
            ／ 柱縁〜アンカー芯 a=${Math.round(a_mm)} mm
          </td>
        </tr>
        <tr><th>コンクリート仕様</th><td colspan="5">${
          escapeHtml(concSpec) || "—"
        }</td></tr>
        <tr><th>適用基準・条文</th><td colspan="5">${
          escapeHtml(lawRef) || "—"
        }</td></tr>
        <tr><th>特記事項</th><td colspan="5">${
          escapeHtml(siteNotes) || "—"
        }</td></tr>
      </table>

      <h3>施工・製作チェック項目</h3>
      <table>
        <tr><th style="width:6%">No</th><th style="width:64%">確認項目</th><th style="width:15%">施工</th><th style="width:15%">確認</th></tr>
        <tr><td>1</td><td>基礎寸法（B×D×H）が本図・本指示書と一致している</td><td>□</td><td>□</td></tr>
        <tr><td>2</td><td>アンカー径・本数・配置・埋込み長さが一致している</td><td>□</td><td>□</td></tr>
        <tr><td>3</td><td>アンカー孔径（d＋クリアランス）が守られている</td><td>□</td><td>□</td></tr>
        <tr><td>4</td><td>ベースプレート板厚・材質・仕上げが一致している</td><td>□</td><td>□</td></tr>
        <tr><td>5</td><td>現地条件（地盤・突出・荷重条件）に変更が無い</td><td>□</td><td>□</td></tr>
      </table>

      <h3>注意事項・責任分界</h3>
<div class="muted">
  <ul>
    <li>本指示書は一次設計（簡易計算法）に基づくものである。</li>
    <li>地盤条件、設置高さ、荷重条件、支持条件に変更がある場合は、再計算を要する。</li>
    <li>アンカーおよび鋼材の最終仕様は、メーカー仕様書および施工要領書を優先する。</li>
    <li>根入れ抵抗（受働土圧）は簡易モデル（Kp固定）であり、地盤条件により大きく変動する。</li>
    <li>${escapeHtml(upliftNoteForPdf)}</li>
  </ul>
</div>
      <h3>適用基準・法令</h3>
      <div class="muted">
        <ul>
          <li>建築基準法 第20条</li>
          <li>建築基準法施行令 第38条</li>
          <li>国土交通省告示 第1456号（工作物の構造安全）</li>
          <li>鋼構造設計規準（許容応力度設計）</li>
          <li>各アンカーメーカー設計・施工指針</li>
        </ul>
      </div>

      <div class='muted' style='margin-top:6px'>
        注）一次設計の簡易式。最終設計は適用基準・メーカー設計資料・地盤調査結果に基づき、有資格者レビューで確認してください。
      </div>
    </section>`;

    document.body.appendChild(container);
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const page = container.querySelector(".page") as HTMLElement;
    const canvas = await html2canvas(page, {
      scale: 2,
      backgroundColor: "#fff",
    });
    const img = canvas.toDataURL("image/png");
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();

    // ★キャンバスの縦横比を維持したまま、A4に「全体が収まる」倍率にする
    const imgW = canvas.width;
    const imgH = canvas.height;

    const scale = Math.min(pw / imgW, ph / imgH);
    const w = imgW * scale;
    const h = imgH * scale;

    const x = (pw - w) / 2;
    const y = (ph - h) / 2;

    doc.addImage(img, "PNG", x, y, w, h, undefined, "FAST");

    document.body.removeChild(container);
    doc.save("sign_report.pdf");
  }

  // ===== AI自動計算：plate t を選択肢へ丸め＋基礎 B/D 独立最適化 =====
  function handleAIAutoCalc() {
    try {
      // 1) 部材の自動選定
      const sameFamily = sections.filter((s) => s.family === family);
      const sorted = [...sameFamily].sort((a, b) => {
        const Za = bendAxis === "x" ? a.Zx_cm3 ?? 0 : a.Zy_cm3 ?? 0;
        const Zb = bendAxis === "x" ? b.Zx_cm3 ?? 0 : b.Zy_cm3 ?? 0;
        return Za - Zb;
      });

      let pickedSection = sameFamily[0] ?? sections[0];

      for (const s of sorted) {
        const Zx_m3 = (s.Zx_cm3 ?? 50) * 1e-6;
        const Zy_m3 = (s.Zy_cm3 ?? 50) * 1e-6;
        const ix_m = (s.ix_cm ?? 3) * 0.01;
        const iy_m = (s.iy_cm ?? 3) * 0.01;
        const Z_cand = bendAxis === "x" ? Zx_m3 : Zy_m3;
        const r_cand = bendAxis === "x" ? ix_m : iy_m;

        const sigma_cand = M / Math.max(Z_cand, 1e-12) / 1e6;
        const eta_cand = sigma_cand / sigma_allow;
        const lambda_cand = (K * L) / Math.max(r_cand, 1e-6);

        pickedSection = s;
        if (eta_cand < 1 && lambda_cand <= 200) break;
      }
      if (pickedSection) setSectionName(pickedSection.name);

      // 2) アンカー種類＋本数の自動選定（1本あたりFh）
      const qtyCandidates = [4, 6, 8, 10];
      const anchorCandidates = [...anchorsForUI].sort((a, b) => a.Ta - b.Ta);

      let bestAnchor = anchor;
      let bestQty = anchorQty;
      let bestEmbed = anchorEmbed;
      let foundAnchorOK = false;

      for (const ac of anchorCandidates) {
        const d_local = ac.d;
        const minEdge_local = ac.min_e ?? Math.round(1.5 * d_local);
        const minSpace_local = ac.min_s ?? Math.round(3 * d_local);
        const edge1OK_c = edge1 >= minEdge_local;
        const edge2OK_c =
          signType === "projecting" ? true : edge2 >= minEdge_local;
        const spacingOK_c = spacing >= minSpace_local;
        if (!edge1OK_c || !edge2OK_c || !spacingOK_c) continue;

        const { list } = computeAnchorTensions(M, anchorGauge, anchorPitch);
        const Tmax_c = Math.max(...list.map((o) => Math.max(0, o.T)), 0);

        const hef_try =
          signType === "freestanding"
            ? d_local * 20
            : ac.hefRec || d_local * 10;

        const Ta_conc_c =
          FcNum > 0 && hef_try > 0
            ? ANCHOR_CONC.k *
              Math.sqrt(FcNum) *
              Math.pow(hef_try, 1.5) *
              ANCHOR_CONC.phi *
              ANCHOR_CONC.psiEdge *
              ANCHOR_CONC.psiCrack
            : 0;

        const Ta_eff_c = Math.min(ac.Ta, Ta_conc_c);

        const ANCHOR_CALC_QTY_FIXED = 4; // ★簡易版は常に4本扱い

        for (const q_local of qtyCandidates) {
          const V_c = Fh / ANCHOR_CALC_QTY_FIXED;

          const etaA =
            (Ta_eff_c > 0 ? Tmax_c / Ta_eff_c : Infinity) +
            (ac.Va > 0 ? V_c / ac.Va : 0);

          if (etaA < 1) {
            bestAnchor = ac;
            bestQty = q_local; // 表示上の本数は更新してよい（計算は固定）
            bestEmbed = hef_try;
            foundAnchorOK = true;
            break;
          }
        }

        if (foundAnchorOK) break;
      }

      setAnchor(bestAnchor);
      setAnchorQty(bestQty);

      const minHefFinal =
        signType === "freestanding"
          ? bestAnchor.d * 20
          : bestAnchor.hefRec || bestAnchor.d * 10;
      setAnchorEmbed(Math.max(bestEmbed, minHefFinal));

      // 3) ベースプレート t（選択肢に丸め）
      const { list: list2 } = computeAnchorTensions(
        M,
        anchorGauge,
        anchorPitch
      );
      const T_row2 = Math.max(
        ...list2.filter((o) => o.y > 0).map((o) => o.T),
        0
      );
      const t_req_calc = computePlateThickness(
        Math.max(T_row2, 0),
        Math.max(10, a_clear),
        Math.max(40, anchorPitch),
        plateFy
      );
      const adoptT = snapPlateT(t_req_calc + 2);
      setPlateT(adoptT);

      // 4) 基礎（自立のみ）B・D・H を最適化（目的関数モード切替）※1本あたりで判定
      if (signType === "freestanding") {
        const DEFAULT_FOOT = { B: 0.8, D: 0.8, H: 0.8 };

        let bestB = DEFAULT_FOOT.B;
        let bestD = DEFAULT_FOOT.D;
        let bestH = DEFAULT_FOOT.H;

        let found = false;

        let bestScore =
          foundationOptMode === "VOL"
            ? DEFAULT_FOOT.B * DEFAULT_FOOT.D * DEFAULT_FOOT.H
            : DEFAULT_FOOT.B * 100 + DEFAULT_FOOT.D * 10 + DEFAULT_FOOT.H;

        {
          const r0 = evalFoundation(
            DEFAULT_FOOT.B,
            DEFAULT_FOOT.D,
            DEFAULT_FOOT.H
          );
          if (r0.ok) found = true;
        }

        for (let B = 0.6; B <= 2.0; B += 0.05) {
          for (let D = 0.6; D <= 2.0; D += 0.05) {
            for (let H = 0.4; H <= 2.0; H += 0.05) {
              const r = evalFoundation(B, D, H);
              if (!r.ok) continue;

              const score =
                foundationOptMode === "VOL" ? r.volume : B * 100 + D * 10 + H;

              if (!found || score < bestScore) {
                bestScore = score;
                bestB = B;
                bestD = D;
                bestH = H;
                found = true;
              }
            }
          }
        }

        if (found) {
          setFootB(Number(bestB.toFixed(2)));
          setFootD(Number(bestD.toFixed(2)));
          setFootH(Number(bestH.toFixed(2)));
        } else {
          let bestNear: any = null;
          for (let B = 0.6; B <= 2.0; B += 0.05) {
            for (let D = 0.6; D <= 2.0; D += 0.05) {
              for (let H = 0.4; H <= 2.0; H += 0.05) {
                const r = evalFoundation(B, D, H);

                const rateOT = r.FS_OT / Math.max(reqFS_OT, 1e-9);
                const rateSL = r.FS_SL / Math.max(reqFS_SL, 1e-9);
                const rateBE =
                  (r.qa_allow_final * 1000) / Math.max(r.sigma_max, 1e-9);

                const rateMin = Math.min(rateOT, rateSL, rateBE);

                const sizePenalty =
                  foundationOptMode === "VOL"
                    ? B * D * H
                    : B * 100 + D * 10 + H;

                const scoreNear = rateMin * 100000 - sizePenalty;

                if (!bestNear || scoreNear > bestNear.scoreNear) {
                  bestNear = { B, D, H, r, scoreNear };
                }
              }
            }
          }

          if (bestNear) {
            setFootB(Number(bestNear.B.toFixed(2)));
            setFootD(Number(bestNear.D.toFixed(2)));
            setFootH(Number(bestNear.H.toFixed(2)));

            alert(
              "AI基礎最適化：OK解が見つかりませんでした。\n" +
                `ただし、最も近い案へ更新しました（allowUpliftOK=${
                  allowUpliftOK ? "ON" : "OFF"
                }）。\n` +
                `B=${bestNear.B.toFixed(2)} D=${bestNear.D.toFixed(
                  2
                )} H=${bestNear.H.toFixed(2)}\n` +
                `達成度(min)=${Math.min(
                  bestNear.r.FS_OT / Math.max(reqFS_OT, 1e-9),
                  bestNear.r.FS_SL / Math.max(reqFS_SL, 1e-9),
                  (bestNear.r.qa_allow_final * 1000) /
                    Math.max(bestNear.r.sigma_max, 1e-9)
                ).toFixed(3)}\n` +
                "不足項目（転倒/滑動/支持力）を結果欄で確認してください。"
            );
          }
        }
      }

      alert(
        "AI自動計算を実行しました。\n" +
          "総合判定がOKに近づくよう、部材・アンカー（埋込み含む）・基礎寸法・プレートt（採用品へ丸め）を自動調整しました。\n" +
          "条件によってはNGが残る場合があります。"
      );
    } catch (e: any) {
      console.error(e);
      alert("AI自動計算中にエラーが発生しました：" + (e?.message || String(e)));
    }
  }

  // ===== UI =====
  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb", padding: 16 }}>
      {/* hidden file input for config */}
      <input
        ref={hiddenCfgInputRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) handleImportConfig(f);
        }}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2,minmax(0,1fr))",
          gap: 8,
          marginTop: 4,
        }}
      >
        <div
          style={{
            fontSize: 12,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div>
            <label>転倒：浮上り有でもOK</label>
            <label
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                marginTop: 2,
              }}
            >
              <input
                type="checkbox"
                checked={allowUpliftOK}
                onChange={(e) => setAllowUpliftOK(e.target.checked)}
              />
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                ON: FS_OTを満たせばOK（浮上りは表示上も注意喚起）
              </span>
            </label>
          </div>
        </div>

        <div style={{ fontSize: 12 }}>
          <label>AI基礎最適化モード</label>
          <select
            style={{
              width: "auto",
              maxWidth: 250,
            }}
            value={foundationOptMode}
            onChange={(e) =>
              setFoundationOptMode(e.target.value as "BD" | "VOL")
            }
          >
            <option value="BD">B・D最小優先</option>
            <option value="VOL">体積最小</option>
          </select>
          <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
            BD: 平面を優先的に小さく / VOL: B×D×H を最小化
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* Header */}
        <div
          style={{
            marginBottom: 8,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: "bold" }}>
            サイン構造計算(簡易版)
          </h1>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
            }}
          >
            <span>力の単位</span>
            <select
              value={forceUnit}
              onChange={(e) => setForceUnit(e.target.value)}
            >
              <option value="N">N</option>
              <option value="kgf">kgf</option>
            </select>

            <span>PDF丸め</span>
            <select
              value={pdfRoundingMode}
              onChange={(e) => setPdfRoundingMode(e.target.value)}
            >
              <option value="round">四捨五入</option>
              <option value="ceil">切上</option>
              <option value="floor">切下</option>
            </select>

            <span>σ桁</span>
            <select
              value={String(pdfSigmaDigits)}
              onChange={(e) => setPdfSigmaDigits(Number(e.target.value))}
            >
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>

            <span>M桁</span>
            <select
              value={String(pdfMDigits)}
              onChange={(e) => setPdfMDigits(Number(e.target.value))}
            >
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>

            <label style={{ display: "inline-flex", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={showAdvanced}
                onChange={(e) => setShowAdvanced(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              詳細
            </label>

            <button
              onClick={downloadPDF}
              style={{
                display: "inline-flex",
                alignItems: "center",
                border: "1px solid #d1d5db",
                padding: "4px 8px",
                borderRadius: 4,
                background: "#fff",
              }}
            >
              <Download size={14} style={{ marginRight: 4 }} />
              PDF
            </button>

            <button
              onClick={() => {
                if (hiddenCfgInputRef.current) {
                  hiddenCfgInputRef.current.value = "";
                  hiddenCfgInputRef.current.click();
                }
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                border: "1px solid #d1d5db",
                padding: "4px 8px",
                borderRadius: 4,
                background: "#fff",
              }}
            >
              <Upload size={14} style={{ marginRight: 4 }} />
              設定読込
            </button>

            <button
              onClick={handleExportConfig}
              style={{
                display: "inline-flex",
                alignItems: "center",
                border: "1px solid #d1d5db",
                padding: "4px 8px",
                borderRadius: 4,
                background: "#fff",
              }}
            >
              <Save size={14} style={{ marginRight: 4 }} />
              設定書出
            </button>

            <button
              onClick={handleAIAutoCalc}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 8px",
                borderRadius: 4,
                border: "none",
                background: "#f59e0b",
                color: "#fff",
              }}
            >
              <Sparkles size={14} style={{ marginRight: 4 }} />
              AI自動計算
            </button>
          </div>
        </div>

        {/* Sticky summary */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
            margin: "0 -16px 8px",
            padding: "4px 16px",
            borderBottom: "1px solid #e5e7eb",
            background: "rgba(255,255,255,0.9)",
            backdropFilter: "blur(4px)",
          }}
        >
          <div
            style={{
              maxWidth: 1200,
              margin: "0 auto",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 11,
            }}
          >
            <span
              style={{
                borderRadius: 4,
                padding: "2px 6px",
                fontWeight: 600,
                color: "#fff",
                background: overallOK ? "#047857" : "#f59e0b",
              }}
            >
              総合：{overallOK ? "OK（一次）" : "注意あり"}
            </span>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                color: "#374151",
              }}
            >
              <span>
                柱本数={nCol_raw}本（計算扱い={nCol}本
                {hasInterPostConnection ? "" : "：連結なし"}）
              </span>

              <span>η部材={fmt(etaColumn, "", 3)}</span>
              <span>λ={fmt(lambda, "", 0)} / 200</span>
              <span>ηｱﾝｶｰ={fmt(etaAnchorLinear, "", 3)}</span>
              <span>ベースt {plateOK ? "OK" : "NG"}</span>
              <span>
                設計Fh（全体）={showF(Fh_total, forceUnit)} / （1本）=
                {showF(Fh, forceUnit)}
              </span>
              <span>
                埋込み hef {hefOK ? "OK" : "NG"}（採用{anchorEmbed} / 要件
                {hefReq} mm）
              </span>

              {signType === "freestanding" && (
                <>
                  <span>
                    OT FS={fmt(FS_OT, "", 2)} / 基準 {reqFS_OT}
                  </span>
                  <span>
                    SL FS={fmt(FS_SL, "", 2)} / 基準 {reqFS_SL}
                  </span>
                  <span>
                    qa判定={(sigma_max / 1000).toFixed(0)}/
                    {qa_allow_final.toFixed(0)} kPa
                  </span>
                  <span>根入れPp={showF(Pp, forceUnit)}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)",
            gap: 12,
          }}
        >
          {/* Left: Inputs */}
          <div
            style={{
              background: "#fff",
              borderRadius: 6,
              border: "1px solid #e5e7eb",
              padding: 12,
            }}
          >
            <div
              style={{
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Settings size={18} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>入力</span>
            </div>

            {/* 種別 */}
            <fieldset
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 8,
                marginBottom: 12,
                fontSize: 12,
              }}
            >
              <legend style={{ padding: "0 4px" }}>看板の種別</legend>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setSignType("freestanding")}
                  style={btnToggleStyle(signType === "freestanding")}
                  type="button"
                >
                  自立看板
                </button>
                <button
                  onClick={() => setSignType("projecting")}
                  style={btnToggleStyle(signType === "projecting")}
                  type="button"
                >
                  袖看板
                </button>
                <button
                  onClick={() => setSignType("wall")}
                  style={btnToggleStyle(signType === "wall")}
                  type="button"
                >
                  壁付看板
                </button>
              </div>
            </fieldset>

            {/* 案件情報（常時表示：PDFへ反映） */}
            <fieldset
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 8,
                marginBottom: 12,
                fontSize: 12,
              }}
            >
              <legend style={{ padding: "0 4px" }}>案件情報（PDF反映）</legend>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: 8,
                }}
              >
                <div>
                  <label>工事名</label>
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "2px 4px",
                    }}
                  />
                </div>

                <div>
                  <label>案件番号</label>
                  <input
                    value={projectNo}
                    onChange={(e) => setProjectNo(e.target.value)}
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "2px 4px",
                    }}
                  />
                </div>

                <div>
                  <label>Rev</label>
                  <input
                    value={rev}
                    onChange={(e) => setRev(e.target.value)}
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "2px 4px",
                    }}
                  />
                </div>
              </div>
            </fieldset>

            {/* 鋼材 DB */}
            <fieldset
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 8,
                marginBottom: 12,
              }}
            >
              <legend style={{ padding: "0 4px", fontSize: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center" }}>
                  <Database size={14} style={{ marginRight: 4 }} />
                  鋼材DB（内蔵サンプル／JSON対応）
                </span>
              </legend>

              {/* ★柱本数を鋼材選択の近くへ移動 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4,minmax(0,1fr))",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <div>
                  <label>鋼材種類</label>
                  <select
                    style={{ width: "100%" }}
                    value={family}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFamily(v);
                      const first = sections.find((s) => s.family === v);
                      setSectionName(first?.name || "");
                    }}
                  >
                    {families.map((f) => (
                      <option key={f} value={f}>
                        {FAMILY_JP_MAP[f] || f}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>断面サイズ</label>
                  <select
                    style={{ width: "100%" }}
                    value={sectionName}
                    onChange={(e) => setSectionName(e.target.value)}
                  >
                    {candidates.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>曲げ方向</label>
                  <select
                    style={{ width: "100%" }}
                    value={bendAxis}
                    onChange={(e) => setBendAxis(e.target.value)}
                  >
                    <option value="x">x（強軸側に曲げ）</option>
                    <option value="y">y（弱軸側に曲げ）</option>
                  </select>
                </div>
                <div>
                  <label>柱本数（postQty）</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={postQty}
                    onChange={(e) =>
                      setPostQty(
                        Math.max(1, Math.floor(Number(e.target.value)))
                      )
                    }
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "2px 4px",
                    }}
                  />

                  {/* ★追加：柱間連結の前提 */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 6,
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hasInterPostConnection}
                      onChange={(e) =>
                        setHasInterPostConnection(e.target.checked)
                      }
                    />
                    <span>
                      柱間連結あり（耐風梁・ブレース等で荷重が均等分担される）
                    </span>
                  </label>

                  <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
                    {hasInterPostConnection
                      ? "ON：荷重を柱本数で割って1本あたりで検定（均等分担）"
                      : "OFF：均等分担できない前提のため、計算上は1本柱扱い（注意）"}
                  </div>

                  {!hasInterPostConnection && postQty > 1 && (
                    <div
                      style={{ marginTop: 4, fontSize: 11, color: "#b91c1c" }}
                    >
                      注意：柱が複数でも「柱間連結なし」の場合、片柱に荷重が偏る可能性があります。
                      本計算は安全側に「1本柱扱い」で検定しています（耐風梁・ブレース等の検討推奨）。
                    </div>
                  )}
                </div>
              </div>

              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                }}
              >
                <label
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    padding: "2px 6px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <input
                    type="file"
                    accept="application/json"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0];
                      if (f) handleImportSections(f);
                      e.currentTarget.value = "";
                    }}
                  />
                  <Upload size={12} />
                  鋼材JSON読込
                </label>
                <button
                  onClick={handleExportSections}
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 4,
                    padding: "2px 6px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    background: "#fff",
                  }}
                >
                  <Save size={12} />
                  現在DBを書出
                </button>
                <span style={{ color: "#6b7280" }}>
                  schema: family/name/Zx_cm3/Zy_cm3/ix_cm/iy_cm
                </span>
              </div>
            </fieldset>

            {/* geometry & loads */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5,minmax(0,1fr))",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <NumInput
                label="看板幅 W"
                unit="m"
                value={width}
                onChange={setWidth}
                min={0.2}
                step={0.1}
              />
              <NumInput
                label="看板高さ H"
                unit="m"
                value={height}
                onChange={setHeight}
                min={0.2}
                step={0.1}
              />
              <NumInput
                label="看板重量"
                unit="kg"
                value={panelKg}
                onChange={setPanelKg}
                min={1}
                step={1}
              />
              <NumInput
                label="看板中心高さ h"
                unit="m"
                value={cgHeight}
                onChange={setCgHeight}
                min={0.5}
                step={0.1}
              />
              <ReadOnly label="基準速度圧 q0" value={fmt(q0, " N/m²")} />
            </div>

            {/* 荷重 */}
            <details open>
              <summary style={{ fontSize: 13, fontWeight: 600 }}>荷重</summary>

              {/* 上段（主要項目） */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <NumInput
                  label="基準風速 V0"
                  unit="m/s"
                  value={windV0}
                  onChange={setWindV0}
                  min={10}
                  step={1}
                />

                {/* Cfの扱い（重要） */}
                <div style={{ fontSize: 12 }}>
                  <label>Cfの扱い（重要）</label>
                  <select
                    style={{ width: "100%" }}
                    value={cfMode}
                    onChange={(e) => setCfMode(e.target.value as any)}
                  >
                    <option value="SHAPE_ONLY">
                      Cf=形状のみ（Kz/Gf/Iw…は別入力）
                    </option>
                    <option value="CF_INCLUDES_ALL">
                      Cfに高さ・ガスト等を含めて入力（Kz/Gf/Iw…は1.0扱い）
                    </option>
                  </select>
                  <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
                    二重掛け防止のため、後者ではKz/Gf/Iw/Kd/Ktは計算上1.0として扱います。
                  </div>
                </div>

                <NumInput
                  label="形状係数 Cf"
                  unit="-"
                  value={shapeCf}
                  onChange={setShapeCf}
                  min={0.5}
                  step={0.1}
                />

                <ReadOnly label="設計速度圧 qz" value={fmt(qz, " N/m²")} />

                <NumInput
                  label="有効面積係数"
                  unit="-"
                  value={areaFactor}
                  onChange={setAreaFactor}
                  min={0.5}
                  step={0.1}
                />

                <NumInput
                  label="地震係数 C0"
                  unit="-"
                  value={seismicC0}
                  onChange={setSeismicC0}
                  min={0}
                  step={0.05}
                />
              </div>

              {/* 下段（風荷重係数：Kz〜Kt） */}
              {cfMode === "CF_INCLUDES_ALL" ? (
                /* ===== Cfにすべて含める場合：入力欄は非表示（説明のみ） ===== */
                <div
                  style={{
                    marginTop: 8,
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px dashed #d1d5db",
                    background: "#f9fafb",
                    fontSize: 11,
                    color: "#6b7280",
                    gridColumn: "1 / -1",
                  }}
                >
                  現在「Cfに高さ・ガスト等を含めて入力」モードです。
                  <br />
                  Kz / Gf / Iw / Kd / Kt は <strong>計算上 1.0 扱い</strong>
                  のため、 入力欄は表示されません（<strong>二重掛け防止</strong>
                  ）。
                </div>
              ) : (
                /* ===== Cf=形状のみの場合：Kz〜Kt を入力 ===== */
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5,minmax(0,1fr))",
                    gap: 8,
                    marginTop: 8,
                    gridColumn: "1 / -1",
                  }}
                >
                  <NumInput
                    label="高さ係数 Kz"
                    unit="-"
                    value={windKz}
                    onChange={setWindKz}
                    min={0.5}
                    step={0.05}
                  />
                  <NumInput
                    label="ガスト係数 Gf"
                    unit="-"
                    value={windGf}
                    onChange={setWindGf}
                    min={0.5}
                    step={0.05}
                  />
                  <NumInput
                    label="重要度係数 Iw"
                    unit="-"
                    value={windIw}
                    onChange={setWindIw}
                    min={0.5}
                    step={0.05}
                  />
                  <NumInput
                    label="風向係数 Kd"
                    unit="-"
                    value={windKd}
                    onChange={setWindKd}
                    min={0.5}
                    step={0.05}
                  />
                  <NumInput
                    label="地形係数 Kt"
                    unit="-"
                    value={windKt}
                    onChange={setWindKt}
                    min={0.5}
                    step={0.05}
                  />
                </div>
              )}

              {/* Fh段（そのまま） */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <ReadOnly
                  label="自動計算Fh(風・地震)（全体）"
                  value={showF(Fh_auto_total, forceUnit)}
                />
                <NumInput
                  label="設計用水平力 Fh（入力・0で自動使用）※全体"
                  unit={forceUnit}
                  value={FhInput}
                  onChange={setFhInput}
                  min={0}
                  step={10}
                />
                <ReadOnly
                  label="現在の設計Fh（1本あたり）"
                  value={showF(Fh, forceUnit)}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <ReadOnly
                  label="設計Fh（全体）"
                  value={showF(Fh_total, forceUnit)}
                />
                <ReadOnly
                  label="設計Fh（1本あたり）"
                  value={showF(Fh, forceUnit)}
                />
                <ReadOnly
                  label="看板自重（1本あたり）"
                  value={showF(Wself_perCol, forceUnit)}
                />
              </div>
            </details>

            {/* 部材 */}
            <details open style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 13, fontWeight: 600 }}>部材</summary>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <NumInput
                  label="鋼材降伏強度 Fy"
                  unit="N/mm²"
                  value={Fy}
                  onChange={setFy}
                  min={150}
                  step={5}
                />
                <NumInput
                  label="K（有効長係数）"
                  unit="-"
                  value={K}
                  onChange={setK}
                  min={0.7}
                  step={0.05}
                />
                <NumInput
                  label="柱の長さ L"
                  unit="m"
                  value={L}
                  onChange={setL}
                  min={1}
                  step={0.1}
                />
              </div>
            </details>

            {/* 支持・アンカー・基礎 */}
            <details open style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 13, fontWeight: 600 }}>
                支持・アンカー・基礎
              </summary>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <NumInput
                  label="アンカー列の縦間隔（上下）"
                  unit="mm"
                  value={anchorGauge}
                  onChange={setAnchorGauge}
                  min={120}
                  step={10}
                />
                <NumInput
                  label="アンカー列の横間隔（左右）"
                  unit="mm"
                  value={anchorPitch}
                  onChange={setAnchorPitch}
                  min={80}
                  step={10}
                />

                <div>
                  <label>アンカー種類</label>
                  <select
                    style={{ width: "100%" }}
                    value={anchor.name}
                    onChange={(e) => {
                      const sel = anchorsForUI.find(
                        (a) => a.name === e.target.value
                      );
                      if (sel) {
                        setAnchor(sel);
                        const minHef =
                          signType === "freestanding"
                            ? sel.d * 20
                            : sel.hefRec || sel.d * 10;
                        setAnchorEmbed((prev) =>
                          Math.max(Number(prev) || 0, minHef)
                        );
                      }
                    }}
                  >
                    {anchorsForUI.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </select>

                  <div style={{ marginTop: 4 }}>
                    <label>アンカー本数</label>
                    <input
                      type="number"
                      min={2}
                      step={1}
                      value={anchorQty}
                      onChange={(e) => setAnchorQty(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <NumInput
                      label="アンカー有効埋込み長さ hef"
                      unit="mm"
                      value={anchorEmbed}
                      onChange={(v) => {
                        const minHef =
                          signType === "freestanding"
                            ? anchor.d * 20
                            : anchor.d * 6;
                        setAnchorEmbed(Math.max(minHef, v));
                      }}
                      min={
                        signType === "freestanding"
                          ? anchor.d * 20
                          : anchor.d * 6
                      }
                      step={10}
                    />
                    <div
                      style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}
                    >
                      {signType === "freestanding"
                        ? "自立：hef は 20d 以上（固定）"
                        : "袖/壁：下限は便宜上 6d、推奨はDBのhefRec（無ければ10d）"}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: 4,
                      display: "flex",
                      gap: 4,
                      fontSize: 11,
                    }}
                  >
                    <label
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 4,
                        padding: "2px 6px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        cursor:
                          signType === "freestanding"
                            ? "not-allowed"
                            : "pointer",
                        opacity: signType === "freestanding" ? 0.6 : 1,
                      }}
                      title={
                        signType === "freestanding"
                          ? "自立看板はABR固定のため、JSON読込は袖/壁付向けです。"
                          : ""
                      }
                    >
                      <input
                        type="file"
                        accept="application/json"
                        style={{ display: "none" }}
                        disabled={signType === "freestanding"}
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0];
                          if (f) handleImportAnchors(f);
                          e.currentTarget.value = "";
                        }}
                      />
                      <Upload size={12} />
                      JSON読込
                    </label>

                    <button
                      onClick={handleExportAnchors}
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 4,
                        padding: "2px 6px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        background: "#fff",
                      }}
                      title="非自立用アンカーDB（anchors）を書き出し"
                    >
                      <Save size={12} />
                      JSON書出
                    </button>
                  </div>

                  <details style={{ marginTop: 4, fontSize: 11 }}>
                    <summary>
                      {signType === "freestanding"
                        ? "ABR アンカー（短期許容）一覧"
                        : "アンカー 推奨埋込み長さ一覧"}
                    </summary>
                    <table
                      style={{
                        width: "100%",
                        marginTop: 4,
                        borderCollapse: "collapse",
                        fontSize: 11,
                      }}
                    >
                      <thead>
                        <tr>
                          <th
                            style={{
                              border: "1px solid #e5e7eb",
                              padding: "2px 4px",
                            }}
                          >
                            サイズ
                          </th>
                          <th
                            style={{
                              border: "1px solid #e5e7eb",
                              padding: "2px 4px",
                            }}
                          >
                            hef要件 [mm]
                          </th>
                          <th
                            style={{
                              border: "1px solid #e5e7eb",
                              padding: "2px 4px",
                            }}
                          >
                            Ta [N]
                          </th>
                          <th
                            style={{
                              border: "1px solid #e5e7eb",
                              padding: "2px 4px",
                            }}
                          >
                            Va [N]
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {anchorsForUI.map((a) => (
                          <tr key={a.name}>
                            <td
                              style={{
                                border: "1px solid #e5e7eb",
                                padding: "2px 4px",
                              }}
                            >
                              {a.name}
                            </td>
                            <td
                              style={{
                                border: "1px solid #e5e7eb",
                                padding: "2px 4px",
                              }}
                            >
                              {signType === "freestanding"
                                ? a.d * 20
                                : a.hefRec || a.d * 10}
                            </td>
                            <td
                              style={{
                                border: "1px solid #e5e7eb",
                                padding: "2px 4px",
                              }}
                            >
                              {a.Ta}
                            </td>
                            <td
                              style={{
                                border: "1px solid #e5e7eb",
                                padding: "2px 4px",
                              }}
                            >
                              {a.Va}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>

                <NumInput
                  label="ベース端〜アンカー芯距離1"
                  unit="mm"
                  value={edge1}
                  onChange={setEdge1}
                  min={20}
                  step={5}
                />
                <NumInput
                  label="ベース端〜アンカー芯距離2"
                  unit="mm"
                  value={edge2}
                  onChange={setEdge2}
                  min={20}
                  step={5}
                />
                <NumInput
                  label="アンカー列間隔 s"
                  unit="mm"
                  value={spacing}
                  onChange={setSpacing}
                  min={40}
                  step={5}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <NumInput
                  label="柱縁〜アンカー芯距離 a"
                  unit="mm"
                  value={a_clear}
                  onChange={setAclear}
                  min={40}
                  step={5}
                />

                {/* ★板厚は採用品の select */}
                <div style={{ fontSize: 12 }}>
                  <label>ベースプレート板厚 t(採用)</label>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 4 }}
                  >
                    <select
                      style={{ width: "100%" }}
                      value={String(plateT)}
                      onChange={(e) => setPlateT(Number(e.target.value))}
                    >
                      {PLATE_T_OPTIONS.map((t) => (
                        <option key={t} value={t}>
                          {t} mm
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>mm</span>
                  </div>
                  <div style={{ marginTop: 2, fontSize: 10, color: "#6b7280" }}>
                    採用品：16/19/22/25/28/32/36
                  </div>
                </div>

                <NumInput
                  label="ベースプレート降伏 Fy"
                  unit="N/mm²"
                  value={plateFy}
                  onChange={setPlateFy}
                  min={150}
                  step={5}
                />
              </div>

              {signType === "freestanding" && (
                <div>
                  {/* ===== 基礎寸法・形状 ===== */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    {/* 基礎形状 */}
                    <div style={{ fontSize: 12 }}>
                      <label>基礎形状</label>
                      <select
                        style={{ width: "100%" }}
                        value={footShape}
                        onChange={(e) =>
                          setFootShape(e.target.value as "RECT" | "L")
                        }
                      >
                        <option value="RECT">矩形</option>
                        <option value="L">L形（片腕・帯）</option>
                      </select>
                    </div>

                    <NumInput
                      label="基礎幅 B（転倒方向）"
                      unit="m"
                      value={footB}
                      onChange={setFootB}
                      min={0.5}
                      step={0.05}
                    />
                    <NumInput
                      label="基礎奥行 D（直角方向）"
                      unit="m"
                      value={footD}
                      onChange={setFootD}
                      min={0.2}
                      step={0.05}
                    />
                    <NumInput
                      label="基礎の深さ H（厚さ）"
                      unit="m"
                      value={footH}
                      onChange={setFootH}
                      min={0.3}
                      step={0.05}
                    />
                    <NumInput
                      label="根入れ深さ z（受働土圧）"
                      unit="m"
                      value={embedDepth}
                      onChange={(v) => {
                        setEmbedDepthAuto(false);
                        setEmbedDepth(v);
                      }}
                      min={0}
                      step={0.05}
                    />

                    {/* ★追加：受働土圧低減係数 */}
                    <NumInput
                      label="受働土圧低減係数 ηp"
                      unit=""
                      value={etaPassive}
                      onChange={setEtaPassive}
                      min={0.1}
                      max={1.0}
                      step={0.05}
                    />
                  </div>

                  {/* ★L形（片腕）のときだけ：帯幅 t */}
                  {footShape === "L" && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                        gap: 8,
                        marginTop: 4,
                      }}
                    >
                      <NumInput
                        label="帯幅 t1（柱直下）"
                        unit="m"
                        value={L_t1}
                        onChange={setLt1}
                        min={0.15}
                        step={0.01}
                      />
                      <NumInput
                        label="帯幅 t2（先端側）"
                        unit="m"
                        value={L_t2}
                        onChange={setLt2}
                        min={0.15}
                        step={0.01}
                      />
                      <ReadOnly
                        label="形状"
                        value={`L形基礎（片腕・t1=${Number(L_t1).toFixed(
                          2
                        )}m, t2=${Number(L_t2).toFixed(2)}m）`}
                      />
                    </div>
                  )}

                  {/* ===== 鉛直力（自重＋土被り） ===== */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3,minmax(0,1fr))",
                      gap: 4,
                      marginTop: 4,
                    }}
                  >
                    {/* ★追加：基礎形状の明示 */}
                    <ReadOnly label="基礎形状" value={foundationShapeText} />

                    {/* ★追加：有効接地面積（式付き） */}
                    <ReadOnly
                      label="有効接地面積 A"
                      value={foundationAreaFormula}
                    />

                    <ReadOnly
                      label="N（基礎＋土被り＋看板自重/本）"
                      value={showF(N_foundation, forceUnit)}
                    />
                    <NumInput
                      label="土の単位体積重量 γ（上載り）"
                      unit="kN/m³"
                      value={soilUnitW}
                      onChange={setSoilUnitW}
                      min={10}
                      step={0.5}
                    />
                    <NumInput
                      label="土被り厚さ T（基礎天端→地盤面）"
                      unit="m"
                      value={coverT}
                      onChange={setCoverT}
                      min={0}
                      step={0.05}
                    />
                  </div>

                  <div style={{ marginTop: 4, fontSize: 11, color: "#6b7280" }}>
                    根入れ抵抗は簡易として、受働土圧係数 Kp={PASSIVE_SOIL.Kp}{" "}
                    を固定し、転倒FSと滑動FSに加味しています（地盤条件で大きく変動）。
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4,minmax(0,1fr))",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    <NumInput
                      label="地盤許容支持力度 qa"
                      unit="kPa"
                      value={soilQa}
                      onChange={setSoilQa}
                      min={50}
                      step={10}
                    />
                    <NumInput
                      label="コンクリート Fc"
                      unit="N/mm²"
                      value={Fc}
                      onChange={setFc}
                      min={18}
                      step={3}
                    />
                    <NumInput
                      label="摩擦係数 μ（基礎底面）"
                      unit="-"
                      value={mu}
                      onChange={setMu}
                      min={0.3}
                      step={0.05}
                    />
                    <ReadOnly
                      label="支持力採用 qa(soil/conc小)"
                      value={`${qa_allow_final.toFixed(0)} kPa`}
                    />
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(4,minmax(0,1fr))",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    <NumInput
                      label="転倒安全率 FS基準"
                      unit="-"
                      value={reqFS_OT}
                      onChange={setReqFS_OT}
                      min={1.0}
                      step={0.1}
                    />
                    <NumInput
                      label="滑動安全率 FS基準"
                      unit="-"
                      value={reqFS_SL}
                      onChange={setReqFS_SL}
                      min={1.0}
                      step={0.1}
                    />
                    <NumInput
                      label="地盤・コンクリの安全率 γ"
                      unit="-"
                      value={gammaBearing}
                      onChange={setGammaBearing}
                      min={0.5}
                      step={0.1}
                    />
                  </div>
                </div>
              )}
            </details>

            {showAdvanced && (
              <details open style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 13, fontWeight: 600 }}>
                  PDF指示書（施工・製作）用の記載
                </summary>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: 8,
                    marginTop: 6,
                  }}
                >
                  <NumInput
                    label="ベースプレート奥行 Dp"
                    unit="m"
                    value={plateD}
                    onChange={setPlateD}
                    min={0.2}
                    step={0.05}
                  />
                  <NumInput
                    label="孔クリアランス"
                    unit="mm"
                    value={holeClearance}
                    onChange={setHoleClearance}
                    min={0}
                    step={1}
                  />
                  <div style={{ fontSize: 12 }}>
                    <label>仕上げ（塗装／亜鉛）</label>
                    <input
                      value={finishSpec}
                      onChange={(e) => setFinishSpec(e.target.value)}
                      placeholder="例：溶融亜鉛めっき HDZ55"
                      style={{
                        width: "100%",
                        borderRadius: 4,
                        border: "1px solid #d1d5db",
                        padding: "2px 4px",
                      }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: 8,
                    marginTop: 6,
                  }}
                >
                  <div style={{ fontSize: 12 }}>
                    <label>作成</label>
                    <input
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      style={{
                        width: "100%",
                        borderRadius: 4,
                        border: "1px solid #d1d5db",
                        padding: "2px 4px",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <label>確認</label>
                    <input
                      value={checker}
                      onChange={(e) => setChecker(e.target.value)}
                      style={{
                        width: "100%",
                        borderRadius: 4,
                        border: "1px solid #d1d5db",
                        padding: "2px 4px",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <label>承認</label>
                    <input
                      value={approver}
                      onChange={(e) => setApprover(e.target.value)}
                      style={{
                        width: "100%",
                        borderRadius: 4,
                        border: "1px solid #d1d5db",
                        padding: "2px 4px",
                      }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <label>適用基準・条文</label>
                  <input
                    value={lawRef}
                    onChange={(e) => setLawRef(e.target.value)}
                    placeholder="例：告示1456号（第◯条 第◯項）"
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "2px 4px",
                    }}
                  />
                </div>

                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <label>現場特記事項</label>
                  <textarea
                    value={siteNotes}
                    onChange={(e) => setSiteNotes(e.target.value)}
                    rows={3}
                    placeholder="例：埋設物注意、締付管理方法、検査立会い等"
                    style={{
                      width: "100%",
                      borderRadius: 4,
                      border: "1px solid #d1d5db",
                      padding: "4px",
                    }}
                  />
                </div>
              </details>
            )}

            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setWidth(2.4);
                  setHeight(1.2);
                  setPanelKg(80);
                  setCgHeight(3.5);
                  setWindV0(34);
                  setShapeCf(1.5);
                  setAreaFactor(1.0);
                  setSeismicC0(0.3);
                  setFamily(sections[0].family);
                  setSectionName(sections[0].name);
                  setBendAxis("x");
                  setFy(235);
                  setK(1.0);
                  setL(3.0);
                  setPostQty(1);
                  setHasInterPostConnection(true);
                  setPlateB(0.4);
                  setEcc(0.05);

                  const defAnchor =
                    signType === "freestanding"
                      ? initialABR
                      : DEFAULT_ANCHORS[1];
                  setAnchor(defAnchor);
                  setAnchorQty(4);
                  setAnchorGauge(200);
                  setAnchorPitch(160);
                  setEdge1(50);
                  setEdge2(50);
                  setSpacing(120);

                  const minHef =
                    signType === "freestanding"
                      ? defAnchor.d * 20
                      : defAnchor.hefRec || defAnchor.d * 10;
                  setAnchorEmbed(minHef);

                  setSoilQa(150);
                  setMu(0.5);
                  setFootB(0.8);
                  setFootD(0.8);
                  setFootH(0.8);
                  setEmbedDepth(0.6);
                  setConcUnitW(24);
                  setPlateFy(235);
                  setAclear(80);
                  setPlateT(16);
                  setReqFS_OT(1.5);
                  setReqFS_SL(1.5);
                  setGammaBearing(1.0);
                  setFc(21);
                  setFhInput(0);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid #d1d5db",
                  background: "#e5e7eb",
                  fontSize: 12,
                }}
              >
                <Wrench size={14} style={{ marginRight: 4 }} />
                既定値に戻す
              </button>

              <button
                onClick={downloadPDF}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 8px",
                  borderRadius: 4,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  fontSize: 12,
                }}
              >
                <Download size={14} style={{ marginRight: 4 }} />
                PDF
              </button>
            </div>
          </div>

          {/* Right: Results */}
          <div
            style={{
              background: "#fff",
              borderRadius: 6,
              border: "1px solid #e5e7eb",
              padding: 12,
            }}
          >
            <div
              style={{
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Calculator size={18} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                結果（一次＋基礎検定）
              </span>
            </div>

            <ResultRow
              label="水平力 Fh（設計・全体）"
              value={showF(Fh_total, forceUnit)}
              hint={
                FhInput > 0
                  ? "入力Fh（全体）を使用"
                  : "風・地震からの自動計算値（全体）を使用"
              }
            />
            <ResultRow
              label="水平力 Fh（設計・1本あたり）"
              value={showF(Fh, forceUnit)}
            />
            <ResultRow
              label="Fh（自動計算参考・全体）"
              value={showF(Fh_auto_total, forceUnit)}
            />
            <ResultRow
              label="モーメント M（1本あたり）"
              value={showM(M, forceUnit)}
            />
            <Divider />

            <ResultRow
              label="部材応力度 σ（1本あたり）"
              value={fmt(sigma, " N/mm²")}
            />
            <ResultRow
              label="許容応力度 σa"
              value={fmt(sigma_allow, " N/mm²")}
            />
            <PassRow
              label="部材検定 η"
              ok={etaColumn < 1}
              value={fmt(etaColumn, "", 3)}
              tip="<1 が目安"
            />
            <PassRow
              label="細長比 λ"
              ok={slenderOK}
              value={`${fmt(lambda, "", 0)} / 200`}
              tip="≤200 目安"
            />
            <Divider />

            <ResultRow
              label="アンカー引張最大（1本）"
              value={showF(Tmax, forceUnit)}
            />
            <ResultRow
              label="アンカーせん断（1本）"
              value={showF(V_anchor, forceUnit)}
              hint="※簡易版：配置2×2（4本）固定で按分（選択本数は表示用）"
            />
            <PassRow
              label="アンカー鋼材（引張）η"
              ok={etaAnchorSteel < 1}
              value={fmt(etaAnchorSteel, "", 3)}
            />
            <PassRow
              label="アンカーコンクリ側 η"
              ok={etaAnchorConc < 1}
              value={fmt(etaAnchorConc, "", 3)}
            />
            <PassRow
              label="ｱﾝｶｰ合成 η(linear)"
              ok={etaAnchorLinear < 1}
              value={fmt(etaAnchorLinear, "", 3)}
              tip="鋼材TaとコンクリTa_concの小さい側＋せん断"
            />
            <PassRow
              label="アンカー端距離"
              ok={edgeOK}
              value={`e1=${edge1}${
                signType !== "projecting" ? ` / e2=${edge2}` : ""
              } mm（min≈${Math.round(minEdge)}）`}
            />
            <PassRow
              label="アンカー列間隔"
              ok={spacingOK}
              value={`s=${spacing} mm（min≈${Math.round(minSpace)}）`}
            />
            <PassRow
              label="アンカー埋込み長さ hef"
              ok={hefOK}
              value={`採用=${anchorEmbed} mm / 要件=${hefReq} mm${
                signType === "freestanding" ? "（20d）" : ""
              }`}
            />
            <Divider />

            <PassRow
              label="ベースプレート曲げ t"
              ok={plateOK}
              value={`${plateT} mm ≥ t_req=${fmt(t_req, " mm", 1)}`}
              tip="片持ちストリップ簡易（採用品：16/19/22/25/28/32/36）"
            />

            {signType === "freestanding" && (
              <>
                <Divider />
                <ResultRow
                  label="偏心 e / B"
                  value={`e=${fmt(e_f, " m", 3)} / B=${fmt(
                    footB,
                    " m",
                    3
                  )}（e/B≈${fmt(e_f / (footB || 1), "", 3)}）`}
                />
                <ResultRow
                  label="地盤反力度 σmax/σmin"
                  value={`${fmt(sigma_max / 1000, " kPa")} / ${fmt(
                    sigma_min / 1000,
                    " kPa"
                  )}`}
                />
                <ResultRow
                  label="地盤・コンクリ許容（小さい側）"
                  value={`${qa_allow_final.toFixed(
                    0
                  )} kPa（soil=${qa_allow_soil.toFixed(
                    0
                  )}, conc=${qa_allow_conc.toFixed(0)}）`}
                />
                <ResultRow
                  label="根入れ抵抗（簡易）"
                  value={`z=${fmt(z_embed, " m", 1)}, Pp=${showF(
                    Pp,
                    forceUnit
                  )}（Kp=${PASSIVE_SOIL.Kp}固定）`}
                />
                <PassRow
                  label="転倒安全率 FS"
                  ok={OT_OK}
                  value={`${fmt(
                    FS_OT,
                    "",
                    2
                  )} ≥ ${reqFS_OT}（${fsOtAssumptionNote}・${
                    noUplift
                      ? "全面圧縮"
                      : allowUpliftOK
                      ? "浮上り許容設計"
                      : "浮上り不可設定"
                  }）`}
                  tip={
                    noUplift
                      ? "全面圧縮状態で転倒安全率を満足"
                      : allowUpliftOK
                      ? "浮上りを許容した設計。転倒安全率により安定性を確認"
                      : "浮上りが生じるため、設定上NG"
                  }
                />
                <PassRow
                  label="滑動安全率 FS"
                  ok={FS_SL >= reqFS_SL}
                  value={`${fmt(FS_SL, "", 2)} ≥ ${reqFS_SL}（摩擦+受働）`}
                  tip="R=μN_eff + Pp を使用"
                />
                <PassRow
                  label="地盤・コンクリートの支持力"
                  ok={bearingOK}
                  value={`σmax=${fmt(
                    sigma_max / 1000,
                    " kPa"
                  )} ≤ ${qa_allow_final.toFixed(0)} kPa`}
                  tip="地盤qa/γ と 0.25Fc の小さい側"
                />
              </>
            )}

            <div
              style={{
                marginTop: 12,
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                What-if：風速→部材検定 η（Fh入力とは独立・1本あたり）
              </div>
              <div style={{ width: "100%", height: 200 }}>
                <ResponsiveContainer>
                  <LineChart data={whatIf}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="V" tickFormatter={(v) => `${v}m/s`} />
                    <YAxis domain={[0, "auto"]} />
                    <Tooltip
                      formatter={(v) => Number(v).toFixed(3)}
                      labelFormatter={(l) => `V=${l} m/s`}
                    />
                    <Line type="monotone" dataKey="eta" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: "#6b7280" }}>
                η&gt;1 は部材↑ / 腕長↓ / アンカー数↑ / 柱本数↑ / Fh見直し
                などで調整
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "#4b5563",
            display: "flex",
            gap: 6,
          }}
        >
          <Info size={14} style={{ marginTop: 2 }} />
          <div>
            本ツールは一次設計の簡易法（Σy²配分・片持ち板曲げ・偏心圧＋滑動・簡易アンカーコンクリ判定・簡易根入れ抵抗）を実装したものです。
            建築確認提出・最終設計に際しては、適用基準・メーカー設計指針・地盤調査結果に基づき、
            有資格構造技術者による検証・補正を前提としてください。
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== 小物コンポーネント（シンプル版） ===== */

function NumInput({
  label,
  unit,
  value,
  onChange,
  min = 0,
  step = 0.1,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const invalid = Number.isNaN(value) || value < min;
  return (
    <div style={{ fontSize: 12 }}>
      <label>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{
            width: "100%",
            borderRadius: 4,
            border: `1px solid ${invalid ? "#fb7185" : "#d1d5db"}`,
            padding: "2px 4px",
          }}
        />
        <span style={{ fontSize: 11, color: "#6b7280" }}>{unit}</span>
      </div>
      {invalid && (
        <div style={{ fontSize: 10, color: "#b91c1c" }}>
          値を確認してください
        </div>
      )}
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12 }}>
      <label>{label}</label>
      <div
        style={{
          marginTop: 2,
          padding: "2px 4px",
          borderRadius: 4,
          border: "1px solid #e5e7eb",
          background: "#f9fafb",
          color: "#111827",
          minHeight: 22,
          display: "flex",
          alignItems: "center",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ResultRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{
        fontSize: 12,
        display: "flex",
        justifyContent: "space-between",
        marginBottom: 2,
      }}
    >
      <div style={{ color: "#4b5563" }}>
        {label}
        {hint && (
          <span style={{ marginLeft: 4, fontSize: 10, color: "#9ca3af" }}>
            ({hint})
          </span>
        )}
      </div>
      <div style={{ fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function PassRow({
  label,
  value,
  ok,
  tip,
}: {
  label: string;
  value: string;
  ok: boolean;
  tip?: string;
}) {
  return (
    <div
      style={{
        marginBottom: 4,
        padding: "4px 6px",
        borderRadius: 4,
        border: `1px solid ${ok ? "#bbf7d0" : "#fecaca"}`,
        background: ok ? "#ecfdf3" : "#fef2f2",
        fontSize: 12,
        display: "flex",
        justifyContent: "space-between",
      }}
    >
      <div>
        {label}
        {tip && (
          <span style={{ marginLeft: 4, fontSize: 10, color: "#6b7280" }}>
            ({tip})
          </span>
        )}
      </div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ margin: "6px 0", height: 1, background: "#e5e7eb" }} />;
}

function btnToggleStyle(active: boolean) {
  return {
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid #d1d5db",
    fontSize: 12,
    background: active ? "#2563eb" : "#f9fafb",
    color: active ? "#fff" : "#111827",
  } as React.CSSProperties;
}
