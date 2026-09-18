// Capturas REALES del cable LLUDP: paquetes UDP de Second Life tal y como los
// manda (o los manda el visor a) una region de produccion, guardados en base64
// sin tocar un solo byte. Estan aqui porque son la prueba de interoperabilidad
// mas fuerte que se puede tener sin un simulador delante: si el codificador
// vuelve a producir estos mismos bytes, el visor habla el protocolo igual que
// el de Linden Lab. Cualquier refactorizacion del codec que rompa el protocolo
// hace saltar este test en vez de fallar de forma silenciosa contra una region
// de verdad.
//
// Origen: pruebas de node-metaverse (testing/packets), capturadas con un visor
// Linden contra una region real. La cabecera LLUDP va incluida en cada
// datagrama, asi que se decodifican con decodePacket() tal cual.
//
// La lista cubre las rutas calientes: handshake de region, terreno, updates de
// prim (completo, comprimido, cacheado, terse), borrado, avatares (apariencia,
// animacion, wearables), chat, IM, stats, parcelas, grupos, teletransporte,
// ajustes del agente, nombres de UUID, dinero, sonidos y pings. Entre todos
// tocan los tres anchos de longitud, los tres tipos de bloque, los valores de
// 64 bits, los campos de texto con terminador NUL, los campos binarios y los
// paquetes comprimidos por ceros y sin comprimir.
//
// `runRecapturasSelfTest()` se ejecuta desde el panel de diagnostico del visor.

import { defaultTemplates } from "./template.js";
import { decodePacket, encodePacket, readMsgNum, zeroCodeExpand } from "./codec.js";

// nombre -> datagrama completo en base64 (cabecera LLUDP incluida).
export const RECAPTURAS = {
  AgentDataUpdateMessageAL: "UAAAAAoA//8Bg5a19DHQtU6biN2vwOOKFWcYQ3VzdG9tZXJTdXBwb3J0T2ZmaWNpYWwACVJlc2lkZW50AA5DYXNwZXIgVGVjaGllAMZCTgVuLPsDIgvKeQTRHgTO+P///40BAAtDYXNwZXJUZWNoAAAAAAoAAAALAAAADAM=",
  AgentDataUpdateMessageL: "QAAAAAIA//8Bg5a19DHQtU6biN2vwOOKFWcYQ3VzdG9tZXJTdXBwb3J0T2ZmaWNpYWwACVJlc2lkZW50AA5DYXNwZXIgVGVjaGllAMZCTgVuLPsDIgvKeQTRHgTO+P///40BAAtDYXNwZXJUZWNoAA==",
  AgentMovementCompleteMessageL: "QAAAAAQA//8A+pa19DHQtU6biN2vwOOKFWc9ZOcnUUdOoqdvdT90fGEIBgFUQ8oDQEIX+QtDAACAP/umXLgAAAAAAE4EAAAJBACNhzpaIwBTZWNvbmQgTGlmZSBTZXJ2ZXIgMTcuMTIuMDEuNTExMTMxAA==",
  AgentWearablesUpdateMessageAZL: "0AAAAAkA//8Bfpa19DHQtU6biN2vwOOKFWcAECoAAwTbWk5fnaNEyJktEYHFeVSY09JTKUKnRSamIn2wwz1ywwFpacfM9y9KdqGbwpPM6M5PV8pTXh8jSeWkeKRDpTgFZAJ5mXArspFI+YkDyR37goQIuxCJqDBgRyKWkouO0at6KQNWbLWe72BB17+m4PKT++pACWVv2aYkSR2TcJGapyGqCQQAAAAIAAAACQI=",
  AttachedSoundMessage: "AAAACGAA/w1NwlmDwP0kIXWFGQh0w86kWZSmbQKzUMrCmQOuk2i9nL/6wqI4rkhgnH1BBPMNgxDNzEw9AA==",
  AvatarAnimationMessageL: "QAAACFsAFNHNW3FiCUWVm/B3G/aJzgAHGC4+FVrxbCJfs2xCgBUZo0yzEgAkCP6e3x0dffT/E4T6ezUPR7ESAC34oOS/W+jyT1KvMJFfTbpJsRIAQrRiFEtEea7euA32FCT/S0mzEgBG+rUmU3TUs9kQu9AYxOQdTrMSAHW20D/1dduW7JqhyEQlFpBQsxIAgzvk7rmXL2VW3v3rUEq4JDOzEgABAAAAAAAAAAAAAAAAAAAAAAEA",
  AvatarAppearanceMessageZL: "wAAAB58A//8AAZ7EWNCbQcdAkZQiCd74FvrFAAFlAAE6Nn0cvvFtQ3WV6IweOq2zoIAAAcIo0c9LXUuohPSJmgeWqpef4X8AGIA/AAOAPwAg/QkocQABNHwAAWgjAAJMhAABT0SVIzN1Oq//o3CeqHxMVrL/y/8AAX8AAn8AAn8AA38ADSYADWgAAXqbAAKWk7JVf39/SgABZNjWzMzMMxlZTMwAAW0AAod/f09/jAABf4J/f39oAAGMf2bdbqV/juWyPwAEf38ABH8AAZ8AArJ/WQACmZZ/dU4AAhQMdXwAAdbMxgADGYzi/8b////////////MAAH//////////////wAB//////8AAZmM/xlk/////1QABD3///8AAhkAARkXMwABGRczAAIZAAEZFzMAAhkAARkXMwABGRczAAEZFzMBfwEBngAHAQAM",
  CameraConstraintMessage: "AAAAB5YAFlhHa792Yr++Rt3/vXo2GkY=",
  ChatFromSimulatorMessageL: "QAAAAEEA//8AixwjRmlyZXN0b3JtIExTTCBCcmlkZ2UgdjIuMjEAu6zSPqdz90fp+iPy+klAw5a19DHQtU6biN2vwOOKFWcCCAEGAVRDyANAQpjVC0PBADxicmlkZ2VVUkw+aHR0cDovL3NpbTEwMDkxLmFnbmkubGluZGVubGFiLmNvbToxMjA0Ni9jYXAvODM5NTBlMDYtNmJlZi0zMmQ3LTlmYWEtOTA1OTIyOThhYWJhPC9icmlkZ2VVUkw+PGJyaWRnZUF1dGg+ZDZhZjMzMDEtZmE5Mi00Y2I4LTMxOGMtM2Y0YTMxMzE0ZGQ5PC9icmlkZ2VBdXRoPjxicmlkZ2VWZXI+Mi4yMTwvYnJpZGdlVmVyPgA=",
  CoarseLocationUpdateMessage: "AAAACGEA/wYIttwf1DAjwUoh1TEjw0shi4wgRFMgio0gAQD//wi16z2q9bxLhqnn3XproANylrX0MdC1TpuI3a/A44oVZ8RY0JtBx0CRlCIJ3vgW+sXRzVtxYglFlZvwdxv2ic4AF2Fvi252TxOMksybvTWikUPP2REaE0ZwgEafk171Z2mAT+yVGB9JcJ4cXjMPg/qkgo9xmELlQbS9YJJqM+oGew==",
  CompletePingCheckMessage: "AAAACEAAAhE=",
  GroupRoleDataReplyMessageL: "QAAAAAsA//8BdJa19DHQtU6biN2vwOOKFWfGQk4Fbiz7AyILynkE0R4EVg/Ns3tYTIOi7S2771U5EAQAAAAEC9HhidcP7Pho5qmquNVj+QlPZmZpY2VycwAIT2ZmaWNlcgBCVGhlIG9mZmljZXJzIG9mIHRoZSBncm91cCwgd2l0aCBtb3JlIHBvd2VycyB0aGFuIHJlZ3VsYXIgbWVtYmVycy4Azvj///+NAQABAAAASDsIDcbz6DzzvuhCXb58EwRBRksAC0FGSyBLaXR0ZW4AAAAAAAAAAAAAAQAAALXELsQi6PaskSY3ACOQi50HT3duZXJzABVDYXNwZXJUZWNoIERldmVsb3BlcgBQVGhlc2UgYXJlIHRoZSBvd25lcnMgb2YgdGhlIGdyb3VwLiAgVGhleSBhbHdheXMgaGF2ZSBGVUxMIFBPV0VSIG92ZXIgdGhlIGdyb3VwLgD//////////wEAAAAAAAAAAAAAAAAAAAAAAAAACUV2ZXJ5b25lAA5DYXNwZXIgVGVjaGllAC9FdmVyeW9uZSBpbiB0aGUgZ3JvdXAgaXMgaW4gdGhlIGV2ZXJ5b25lIHJvbGUuAAAAARgACAAAAAAAAA==",
  HealthMessageMessageL: "QAAAAAYA//8AigAAyEI=",
  ImprovedInstantMessageMessageZL: "wAAAB3IA//8AAf7RzVtxYglFlZvwdxv2ic4AEpa19DHQtU6biN2vwOOKFWcBAAMczy807OpA9br/Tw5Pnl/qZDtVQysYRUKk8AtDAAEW6RGOiRa8JCkF17l42KCdYwAEDkNhc3BlciBXYXJkZW4AAUwAAUpvaW4gbWUgaW4gSXphbmFnaQpodHRwOi8vbWFwcy5zZWNvbmRsaWZlLmNvbS9zZWNvbmRsaWZlL0l6YW5hZ2kvMjEzLzQ5LzE0MAABIwABMjY0NDQ4fDI4MjExMnwyMTJ8NDh8MTQxfDF8MXwtMHxNIAABBxwAAg==",
  ImprovedTerseObjectUpdateMessageL: "QAAACF0ADwBOBAAACQQAtf4MLFCxACYAAJrAYkONGGJDWh7/Qv9//3//f/9//3//f/9//3++Cfuw/3//f/9/igCGAAAAV0jezPYpRhyaNqNaIh/iHwlKALtcH7OSfIEmIR36ZGt4BD0CctllnO3nQNQg4gDZ2kMC6BI+CZLNcJAHxYFxPYbomgDl//8ADwAAAAAAAACAPwAAAIA/CAAAAEEBAAAAQAAAAAAAAAEBQAAAAAAgAAAA5g8AAAAAAAAAAAAAAAAAAAAAAAAs+9zCIgAA3ud4PG5PkDr1ZRk+/3//f/9//3//f/9/fSX/f30l/3//f/9//38AACwA3cIiAACT7QBDYF5FQ1/RA0P/f/9//3//f/9//3//f/9/liWb2v9//3//fwAALGPmCyQAAJtVjz6IgIO9YAEcvv9//3//f/9//3//f/9//3//f////3//f/9/QwA/AAAADc0aSIoKGDvP+GEilMGe3gAAAAD/AAAAgD8AAACAPwAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAALGTmCyQAAJtVjz7NWzW9ZForvv9//3//f/9//3//f/9//3//f////3//f/9/QwA/AAAADc0aSIoKGDvP+GEilMGe3gAAAAAAAAAAgD8AAACAPwAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAALGfmCyQAAFQDQkMF8kJD/Hj9Qv9//3//f/9//3//f/9//3++Cfuw/3//f/9/WQBVAAAAL6W/cv9IWUvRX8rZBPm63gFXSN7M9ilGHJo2o1oiH+IfAAAAAAABAAAA/wAAAIA/AAAAgD8AAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAACwD64oiAAB40udA1NaIufhvuL//f/9//3//f/9//3/+P/6//z/+v/9//3//fwAALAXriiIAAHjS50DU1oi5/Z+zv/9//3//f/9//3//f/4//r//P/6//3//f/9/AAAssQyLIgAANLYCQ0bnGkOvGQJD/3//f/9//3//f/9//3//f/9/////f/9//38AACw/JzAjAABsCXk8GLSQOh9kGT7/f/9//3//f/9//399Jf9/fSX/f/9//3//fwAALD4nMCMAADPc2kI/ir1CdbADQ/9//3//f/9//3//f/9//3/UK5Ef/3//f/9/AAAsU7EAJgAAvF1hQ8OkXEOve/RC/3//f/9//3//f/9//3//f8ntzcH/f/9//39DAD8AAACl2MKM3Et5Yzx/2quYL8T3AAAAAAAAAACAPwAAAIA/AAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  KillObjectMessageL: "QAAACCgAEAauDIsirwyLIrIMiyKzDIsi7nOLIu9ziyI=",
  LayerDataMessage: "AAAACF8ACzcZABIAEDdHdmeiwAEAAD/eRzxoqj8BAAA/xmE=",
  LayerDataMessageL: "QAAAADIAC0xLAQgBEEyLAAAAAAEABz//6LAAAAAAEAbD//6LAAAAAAEAjT//6LAAAAAAEASz//6LAAAAAAEA7z//6LAAAAAAEArj//6LAAAAAAEACD//6LAAAAAAEAKj//6LAAAAAAEAzz//6LAAAAAAEACT//6LAAAAAAEAbT//6LAAAAAAEATD//6LAAAAAAEAjj//6LAAAAAAEAKz//6LAAAAAAEArz//6LAAAAAAEACj//6LAAAAAAEATT//6LAAAAAAEAbj//6LAAAAAAEALD//6LAAAAAAEAjz//6LAAAAAAEACz//6LAAAAAAEATj//6LAAAAAAEALT//6LAAAAAAEAbz//6LAAAAAAEADD//6LAAAAAAEATz//6LAAAAAAEALj//6LAAAAAAEADT//6LAAAAAAEALz//6LAAAAAAEADj//6LAAAAAAEADz//5hA=",
  LogoutReplyMessageL: "QAAACGIA//8A/Za19DHQtU6biN2vwOOKFWc9ZOcnUUdOoqdvdT90fGEIBDPg0+mwojV9pdsqZoaWLbvsRMmXf5A2WbaCnHd2AgqON9clantZM4if9Mts+tRpheX7+4l6/Bm3bZECwIV8P5w=",
  MapBlockReplyMessageL: "QAAAB3YA//8BmZa19DHQtU6biN2vwOOKFWcAAAAAAQkETgQISXphbmFnaQAVAAAAAAAARHQA3gED2pKpdiNNivKTOg==",
  MapItemReplyMessageL: "QAAAB3gA//8Bm5a19DHQtU6biN2vwOOKFWcCAAAABgAAAAVACQQAUE4EAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAc4MDdEREQAgAkEAIBOBAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAHODA3REREALAJBADQTgQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAABzgwN0RERADACQQAQE4EAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAc4MDdEREQA0AkEADBOBAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAHODA3REREAA==",
  MoneyBalanceReplyMessageZL: "wAAABy0A//8BOpa19DHQtU6biN2vwOOKFWcM9OkLJgZhZS7P8iNuzErvAQQACxxDYXNwZXIgV2FyZGVuIHBhaWQgeW91IEwkMi4AAYkTAALRzVtxYglFlZvwdxv2ic4AApa19DHQtU6biN2vwOOKFWcAAQIABA==",
  ObjectUpdateCachedMessageL: "QAAABQ4ADgBOBAAACQQANf4ik7F5IP5KAADQgAIQlLF5IAkAAADQAAIQlbF5IIoQAADQAAIQlrF5IFAQAADQAAIQl7F5IJQWAADQAAIQmLF5IAcRAADQAAIQmbF5ILgPAADQAAIQ5ER1IAoBAADQgAIQ4ER1IBYBAADQgAIQE3NzICY3AADQBAAAk57GICgGAADQBAAQyqHGIB8AAAAQCAIQBHNzIEQDAADQBAAABXNzIL0IAADQDAIABnNzINQIAADQDAIAB3NzINMIAADQDAIACHNzINEIAADQDAIACXNzINIIAADQDAIACnNzILAJAADQDAIAC3NzIMwEAADQDAIADHNzIMsDAADQDAIADXNzIL4DAADQDAIADnNzIM8DAADQDAIAD3NzIMQDAADQDAIAEHNzILoDAADQDAIAEXNzIMYBAADQDAIAEnNzINICAADQDAIAt6HGICUAAAAQCAIQyE54IP/2CADQAAIQ9KxzIG0BAAAQCAIQx054IDmhCADQCAIQYKDGIIYFAADQAAIQXqDGIE0AAADQCAIQX6DGIE4AAADQCAIQ",
  ObjectUpdateCompressedMessageL: "QAAABVwADQBOBAAACQQAYv8DEAgCEOgAu4gq5l6dWr/0G7tSAt6Dpr0urSEJAB5AAAADAM41pD3UNos88wizPcBoh0Cx1xBAqvF5RUYzij3rgTU/wKmjvQAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAEQAAADZjUHOHqIUV/hzRZ8GrB2IFEAAAAABkZAAAAAAAAAAAAAAAAAAAAABhAAAAV0jezPYpRhyaNqNaIh/iHwJaMXiyp8WtQvrr7YsolgSnARHlLUoon7Yokp1Rlhj2pdIAAAAAAAAAAIA/AAAAgD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANAEABDGALlvAkZiviTpTaIcCUuZ48dI1kshCQB1BgAAAwAK1yM8CtcjPArXIzz///9CAAAAQwIAekQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFgABEAAABbxa9QIWpLMY6q1wRYS1WOBSAAAAAAZKUAAAAAAAAAAAAAAAAAAPoAPwAAAHB5pZ3zJLS2NgdS9rJiql4AAAAA/wAAAIA/AAAAgD8AAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAhC4AMLXQNaXlXttZfp1d5pzAqBAlfMJCQDeAAAAAwCPwvU8j8L1PI/C9TyKdsFAcxngQM/1eUUAAAAA9AQ1PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAGRkAACcZAAAAAAABQAAAADzfkgAAABXSN7M9ilGHJo2o1oiH+IfAP///wAEAAAAzAAAAIA/AAAAgD8AAAAAAAAAAAAAwAQgAAAAAAQmAAAAAAAAAAAAAAAAAAAAAAA=",
  ObjectUpdateMessageZL: "wAAACFgADAABTgQAAgkEAAH//wHx6ooiAAGew2UP8qq49Goc3d1mHhV9lGCeHAkDAAGAS8k/N8NEPgrXIzw8+Kf8wFUvJ8D6/7HAABigxBw/psQcvy8Etb4ADAvriiJQAAIQEAEABGRkAA9ZAAHegaaOxncuzq3jE596mJ7eH4lVZ0cky0PtkgtHyu0VRl8AAn//AAEfAAP/AAOAPwADgD8ACiAfAAQNHwAeOQIgAAEQAAP/gAAB/wACIEEABoA/QAABHAAD3oGmjsZ3Ls6t4xOfepie3gACwD8AAoA/AEY=",
  OnlineNotificationMessageL: "QAAAB2QA//8BQgHRzVtxYglFlZvwdxv2ic4A",
  PacketAckMessage: "AAAACEEA////+wHWBwAA",
  ParcelOverlayMessageZL: "wAAAAB0A//8AAcQDAAQEYSEhIUEBAQEBAQEBAQEBAQEBAQEBgWEhISEhISEhISEhISEhISEhISEhYSEhISEhISEhISEhISEhISEhoWEhIWEhIcEBAQEBAQEBAQEBAQEBAQEBAQFhISEhISEhISEhISEhISEhISEhIWEhISEhISEhISEhISEhISEhISGhYSFhwYEBAQEBAQEBAQEBAQEBAQEBAQEBYSEhISEhISEhISEhISEhISEhISGhYSEhISEhISEhISEhISEhISEhIaFhwQEBAQEBAQEBAQEBAQEBAQEBAQEBAYFhISEhISEhISEhISEhISEhISEh4SEhISEhISEhISEhISEhISEhISEhoUEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBYSEhISEhISEhISEhISEhISEhIWEhISEhISEhISEhISEhISEhISEhISFBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAWEhISEhISEhISEhISEhISEhISFhISEhISEhISEhISEhISEhISEhISEhQQEBAQEBAQEBAQEBAQEBAQEBAQEBAQFhISEhISEhISEhISEhISEhISEhYSEhISEhISEhISEhISEhISEhISEhIUEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBYSEhISEhISEhISEhISEhISEhIWEhISEhISEhISEhISEhISEhISEhISFBAQEBAQEBAQEBAQEBAQEBAQEBAQEB4SEhISEhISEhISEhISEhISEhISFhISEhISEhISEhISEhISEhISEhISEhQQEBAQEBAQEBAQEBAQEBAQEBAQEBAWEhISEhISEhISEhISEhISEhISEhYSEhISEhISEhISEhISEhISEhISEhIUEBAQEBAQEBAQEBAQEBAQEBAQEBAQFhISEhISEhISEhISEhISEhISEhIWEhISEhISEhISEhISEhISEhISEhISFBAQEBAQEBAQEBAQEBAQEBAQEBAQHhISEhISEhISEhISEhISEhISEhISGhYSEhISEhISEhISEhISEhISEhISEhQQEBAQEBAQEBAQEBAQEBAQEBAQHhISEhISEhISEhISEhISEhISEhISEhIaFhISEhISEhISEhISEhISEhISEhIUEBAQEBAQEBAQEBAQEBAQEBAeGhISEhISEhISEhISEhISEhISEhISEhISEhoWEhISEhISEhISEhISEhISEhISFBAQEBAQEBAQEBAQEBAQEBAQFhISEhISEhISEhISEhISEhISEhISEhISEhISGhYSEhISEhISEhISEhISEhISEhQQEBAQEBAQEBAQEBAQEBAQHhISEhISEhISEhISEhISEhISEhISEhISEhISEhIaFhISEhISEhISEhISEhISEhIQ==",
  RegionHandshakeMessageZL: "wAAAAAMA//8AAZS2gBAUFQhJemFuYWdpAAHRzVtxYglFlZvwdxv2ic4ABKBBAAS57rsvZUn4Q4XdtfEX7BcGuNOWWq14v0Npm7/47KbJdau3g+Y+kybAJIokdmaFXaMXnNq9OYqbaxORTcMzujIfvrFpxxHq//Lv5Q8k3Igd8lR/UDKCoj2hOTpO+MQ1MiWBcuPdaNcfSqcimIcG/SeyzAY+WPm34v8FT0ql0aWZJBnntqfE0y8Q76f3waadQyMAAnDBAAJwwQAG3MEAAtxCAALwQgAC8EIAAvBCHM8vNOzqQPW6/08OT55f6iEDAAIBAAMJQ2hhbmRsZXIAAQQwMjQAARVFc3RhdGUgLyBGdWxsIFJlZ2lvbgABAbaAEBQABAEABw==",
  ScriptControlChangeMessageL: "QAAAAEAA//8AvQIAPwB4AAEBPwB4AAE=",
  SimStatsMessage: "AAAACF4A//8AjAkEAABOBAAAtoAQFCBOAAAjAAAAAO/rfj8BAAAAQXkzQgIAAAD6zTNCAwAAAAAAAEEfAAAA60sDRAQAAAB51LFBBQAAABmzhz4GAAAA6U/wPwcAAACplwJACAAAAFXMDT8JAAAANboePQoAAADEdzRBCwAAAAAwe0UMAAAAACCBRA0AAAAAAABBDgAAAAAAAAAPAAAAAMAGRREAAABwNkxCEgAAAMJiykITAAAAAAAAABQAAAAAAAAAGAAAAFQtBUMZAAAAAAAAABoAAAAAAAAAGwAAAC5n5D8cAAAArj9hPR0AAADPqgM+HgAAAOrj0UEgAAAANx/IQCEAAACWscpAIgAAANg8Ej0jAAAAtE7HQiYAAAC7aKs6JwAAAAAAAAAoAAAAAAAAAOcfAAABtoAQFAAAAAA=",
  SimulatorViewerTimeMessageMessageL: "QAAACFEA//8AltMHEJzHYAUAQDgAAMBqAgDOcQqzQH0Fv/twWj/bD8k/AAAAAAeTbjkFk245",
  SoundTriggerMessage: "AAAAB7AAHb5YLl2xI0GioVBFTDnpYciWtfQx0LVOm4jdr8DjihVnlrX0MdC1TpuI3a/A44oVZwAAAAAAAAAAAAAAAAAAAAAATgQAAAkEAAAAVEMAAEBCbeQLQ0JSwz8=",
  StartPingCheckMessage: "AAAACE4AARFJCAAA",
  TeleportLocalMessageL: "QAAAB38A//8AQJa19DHQtU6biN2vwOOKFWcCAAAAAABUQwAAQEIAAA1DXEpRvxB6Or6M2wu/BAACAA==",
  TeleportProgressMessage: "AAAAB34A//8AQpa19DHQtU6biN2vwOOKFWcEAAIAC2NvbXBsZXRpbmcA",
  TeleportStartMessageL: "QAAAB30A//8ASQQAAgA=",
  TerminateFriendshipMessageL: "QAAABpwA//8BLJa19DHQtU6biN2vwOOKFWc9ZOcnUUdOoqdvdT90fGEI0c1bcWIJRZWb8Hcb9onOAA==",
};

// Nombres en orden, para recorrer la lista de forma estable.
export const NOMBRES_RECAPTURA = [
  "AgentDataUpdateMessageAL",
  "AgentDataUpdateMessageL",
  "AgentMovementCompleteMessageL",
  "AgentWearablesUpdateMessageAZL",
  "AttachedSoundMessage",
  "AvatarAnimationMessageL",
  "AvatarAppearanceMessageZL",
  "CameraConstraintMessage",
  "ChatFromSimulatorMessageL",
  "CoarseLocationUpdateMessage",
  "CompletePingCheckMessage",
  "GroupRoleDataReplyMessageL",
  "HealthMessageMessageL",
  "ImprovedInstantMessageMessageZL",
  "ImprovedTerseObjectUpdateMessageL",
  "KillObjectMessageL",
  "LayerDataMessage",
  "LayerDataMessageL",
  "LogoutReplyMessageL",
  "MapBlockReplyMessageL",
  "MapItemReplyMessageL",
  "MoneyBalanceReplyMessageZL",
  "ObjectUpdateCachedMessageL",
  "ObjectUpdateCompressedMessageL",
  "ObjectUpdateMessageZL",
  "OnlineNotificationMessageL",
  "PacketAckMessage",
  "ParcelOverlayMessageZL",
  "RegionHandshakeMessageZL",
  "ScriptControlChangeMessageL",
  "SimStatsMessage",
  "SimulatorViewerTimeMessageMessageL",
  "SoundTriggerMessage",
  "StartPingCheckMessage",
  "TeleportLocalMessageL",
  "TeleportProgressMessage",
  "TeleportStartMessageL",
  "TerminateFriendshipMessageL",
];

function base64ABytes(texto) {
  const bin = atob(texto);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Bytes crudos de una captura (copia, para que nadie los toque por accidente).
export function bytesDeRecaptura(nombre) {
  const b64 = RECAPTURAS[nombre];
  if (!b64) throw new Error("captura desconocida: " + nombre);
  return base64ABytes(b64);
}

// Autotest de interoperabilidad: decodifica cada captura real y la vuelve a
// codificar, exigiendo que salga BYTE A BYTE identica. Para las capturas
// comprimidas por ceros se respeta la bandera de compresion original, porque el
// simulador no comprime todo lo que la plantilla dice que se puede comprimir
// (AgentDataUpdate, por ejemplo, viaja sin comprimir aunque su plantilla sea
// zerocoded): el codificador acepta la anulacion explicita por eso mismo.
//
// Comprueba ademas que la decodificacion consume el datagrama entero
// (`trailing` = 0), que es la otra mitad del contrato: unos tipos de bloque
// mal leidos dejarian bytes sueltos al final.
export function runRecapturasSelfTest() {
  let checks = 0, passed = 0;
  const fails = [];
  const ok = (name, cond, got) => { checks++; if (cond) passed++; else fails.push({ name, got }); };
  const t = defaultTemplates();
  const iguales = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  for (const nombre of NOMBRES_RECAPTURA) {
    const bytes = bytesDeRecaptura(nombre);
    let msg;
    try {
      msg = decodePacket(bytes, t);
    } catch (e) {
      ok("recapturas: " + nombre + " decodifica", false, (e && e.message) || String(e));
      continue;
    }
    ok("recapturas: " + nombre + " decodifica", true, null);
    ok("recapturas: " + nombre + " sin bytes de sobra", msg.trailing === 0, msg.trailing);

    const zerocoded = (bytes[0] & 0x80) !== 0;
    let extra = new Uint8Array(0);
    if (bytes[5]) {
      const cuerpo = zerocoded ? zeroCodeExpand(bytes.subarray(6)) : bytes.subarray(6);
      const mn = readMsgNum(cuerpo);
      extra = cuerpo.subarray(mn.len, mn.len + bytes[5]);
    }

    let salida;
    try {
      salida = encodePacket({
        name: msg.name, blocks: msg.blocks, flags: bytes[0] & ~0x80,
        packetId: msg.packetId, acks: msg.acks, extra, zerocoded,
      }, t);
    } catch (e) {
      ok("recapturas: " + nombre + " recodifica igual", false, (e && e.message) || String(e));
      continue;
    }
    ok("recapturas: " + nombre + " recodifica igual", iguales(bytes, salida), {
      original: bytes.length, recodificado: salida.length,
    });
  }

  return { checks, passed, fails };
}
