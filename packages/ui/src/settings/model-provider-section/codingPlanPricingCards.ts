// 原生价卡与内嵌官网购买都已下线。forceOAuth 只留在类型里，避免调用方签名断裂，
// 但不能再打开产品登录。

export type CodingPlanLoginOptions = {
  forceOAuth?: boolean;
};
