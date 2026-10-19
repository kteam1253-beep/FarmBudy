CancelContractEvent = {}
local CancelContractEvent_mt = Class(CancelContractEvent, Event)

InitEventClass(CancelContractEvent, "CancelContractEvent")

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


function CancelContractEvent.emptyNew()
  local self = Event.new(CancelContractEvent_mt)
  return self
end

function CancelContractEvent.new(contractId, farmId)
  local self = CancelContractEvent.emptyNew()
  self.farmId = farmId
  self.contractId = contractId
  return self
end

function CancelContractEvent:writeStream(streamId, connection)
  streamWriteInt32(streamId, self.farmId)
  streamWriteInt32(streamId, self.contractId)
end

function CancelContractEvent:readStream(streamId, connection)
  self.farmId = streamReadInt32(streamId)
  self.contractId = streamReadInt32(streamId)
  self:run(connection)
end

function CancelContractEvent:run(connection)
  local senderFarmId = getSenderFarmId(connection, self.farmId)
  if not connection:getIsServer() then
    g_server:broadcastEvent(CancelContractEvent.new(self.contractId, senderFarmId))
  end

  local contractManager = g_currentMission.customContracts.ContractManager
  contractManager:handleCancelRequest(senderFarmId, self.contractId)
end
