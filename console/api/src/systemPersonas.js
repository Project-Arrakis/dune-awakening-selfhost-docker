// Reserved, non-player identities used by the game and the console. Their
// numeric tuples are stable identifiers; display names are presentation only
// and may be encrypted or absent from the legacy player_state view.
export const FUNCOM_GM_PERSONA = {
  accountId: "9000001",
  displayName: "GM",
  playerControllerId: "900000101",
  playerStateId: "900000102",
  playerPawnId: "900000103"
};

export const CARE_PACKAGE_SERVER_PERSONA = {
  accountId: "9000002",
  funcomId: "Server#4242",
  hexFlsId: "5E121CE000000001",
  displayName: "Server",
  playerControllerId: "900000201",
  playerStateId: "900000202",
  playerPawnId: "900000203"
};

export const MESSAGE_OF_THE_DAY_PERSONA = {
  accountId: "9000003",
  funcomId: "MOTD#4242",
  hexFlsId: "5E121CE000000002",
  displayName: "Message of the Day",
  playerControllerId: "900000301",
  playerStateId: "900000302",
  playerPawnId: "900000303"
};
