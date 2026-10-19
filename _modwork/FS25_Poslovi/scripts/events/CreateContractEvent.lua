CreateContractEvent = {}
local CreateContractEvent_mt = Class(CreateContractEvent, Event)

InitEventClass(CreateContractEvent, "CreateContractEvent")

local function getSenderFarmId(connection, fallback)
  -- Try the most common places FS exposes farmId
  if connection ~= nil then
    if connection.getFarmId ~= nil then
      local ok, fid = pcall(function() return connection:getFarmId() end)
      if ok and fid ~= nil then return fid end
    end
    if connection.player ~= nil and connection.player.farmId ~= nil then
      return connection.player.farmId
    end
  end
  return fallback
end


function CreateContractEvent.emptyNew()
  local self = Event.new(CreateContractEvent_mt)
  return self
end

function CreateContractEvent.new(payload, farmId)
  local self = CreateContractEvent.emptyNew()
  self.payload = payload
  self.farmId = farmId
  return self
end

function CreateContractEvent:writeStream(streamId, connection)
  streamWriteInt32(streamId, self.farmId)
  streamWriteInt32(streamId, self.payload.fieldId)
  streamWriteString(streamId, self.payload.workType)
  streamWriteInt32(streamId, self.payload.reward)
  streamWriteString(streamId, self.payload.description)
  streamWriteInt32(streamId, self.payload.startPeriod)
  streamWriteInt32(streamId, self.payload.startDay)
  streamWriteInt32(streamId, self.payload.duePeriod)
  streamWriteInt32(streamId, self.payload.dueDay)
end

function CreateContractEvent:readStream(streamId, connection)
  self.farmId = streamReadInt32(streamId)
  self.payload = {
    fieldId     = streamReadInt32(streamId),
    workType    = streamReadString(streamId),
    reward      = streamReadInt32(streamId),
    description = streamReadString(streamId),
    startPeriod = streamReadInt32(streamId),
    startDay    = streamReadInt32(streamId),
    duePeriod   = streamReadInt32(streamId),
    dueDay      = streamReadInt32(streamId)
  }

  self:run(connection)
end

function CreateContractEvent:run(connection)
  local senderFarmId = getSenderFarmId(connection, self.farmId)
  if not connection:getIsServer() then
    g_server:broadcastEvent(CreateContractEvent.new(self.payload, senderFarmId))
  end

  local farmId = self.farmId
  if farmId == nil or farmId == FarmManager.SPECTATOR_FARM_ID then
    return
  end

  local contractManager = g_currentMission.customContracts.ContractManager
  contractManager:handleCreateRequest(farmId, self.payload)
end
