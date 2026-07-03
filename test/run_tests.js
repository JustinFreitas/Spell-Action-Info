const { LuaFactory } = require('wasmoon');
const fs = require('fs');
const path = require('path');

// Read Lua files
const saiOptionsInitLua = fs.readFileSync(path.join(__dirname, '../scripts/sai_data_options_init.lua'), 'utf8');
const visibilityComponentsLua = fs.readFileSync(path.join(__dirname, '../campaign/scripts/visibility_components.lua'), 'utf8');
const powerItemLua = fs.readFileSync(path.join(__dirname, '../campaign/scripts/power_item.lua'), 'utf8');
const spellLua = fs.readFileSync(path.join(__dirname, '../campaign/scripts/spell.lua'), 'utf8');

// Global test variables
let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${expected}, got ${actual}`);
  }
}

async function test(name, fn) {
  testCount++;
  try {
    await fn();
    console.log(`✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    failCount++;
  }
}

// Helper to create a fully initialized Lua engine with Fantasy Grounds DB mocks and basic managers
async function createLuaEngine() {
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  // Define DBNode and DB mocks in Lua
  await lua.doString(`
    local unpack = unpack or table.unpack

    DBNode = {}
    DBNode_methods = {}

    function DBNode.new(name, parent)
        local self = setmetatable({}, DBNode)
        self.name = name or ""
        self.parent = parent
        self.children = {}
        self.value = nil
        self.type = nil
        return self
    end

    function DBNode_methods.getName(self)
        return self.name
    end

    function DBNode_methods.getPath(self)
        if self.parent then
            local ppath = DBNode_methods.getPath(self.parent)
            if ppath ~= "" then
                return ppath .. "." .. self.name
            end
        end
        return self.name
    end

    function DBNode_methods.getParent(self)
        return self.parent
    end

    function DBNode_methods.getChild(self, path)
        if not path or path == "" then return self end
        
        local leadingDots = 0
        while leadingDots < #path and path:sub(leadingDots + 1, leadingDots + 1) == "." do
            leadingDots = leadingDots + 1
        end
        
        local current = self
        if leadingDots > 0 then
            local levelsUp = leadingDots - 1
            for i = 1, levelsUp do
                if current.parent then
                    current = current.parent
                else
                    current = nil
                    break
                end
            end
            path = path:sub(leadingDots + 1)
        end
        
        if path == "" then return current end
        if not current then return nil end
        
        for part in path:gmatch("[^%.]+") do
            if not current.children[part] then
                return nil
            end
            current = current.children[part]
        end
        return current
    end

    function DBNode_methods.createChild(self, name, type)
        if not name or name == "" then
            local id = 1
            while self.children["id-" .. string.format("%05d", id)] do
                id = id + 1
            end
            name = "id-" .. string.format("%05d", id)
            
            local child = DBNode.new(name, self)
            self.children[name] = child
            if type then child.type = type end
            return child
        end
        
        local leadingDots = 0
        while leadingDots < #name and name:sub(leadingDots + 1, leadingDots + 1) == "." do
            leadingDots = leadingDots + 1
        end
        
        local current = self
        if leadingDots > 0 then
            local levelsUp = leadingDots - 1
            for i = 1, levelsUp do
                if current.parent then
                    current = current.parent
                else
                    current = nil
                    break
                end
            end
            name = name:sub(leadingDots + 1)
        end
        
        if not current then return nil end
        if name == "" then return current end
        
        for part in name:gmatch("[^%.]+") do
            if not current.children[part] then
                current.children[part] = DBNode.new(part, current)
            end
            current = current.children[part]
        end
        
        if type then
            current.type = type
        end
        return current
    end

    function DBNode_methods.getValue(self)
        return self.value
    end

    function DBNode_methods.setValue(self, val, type)
        self.value = val
        if type then
            self.type = type
        end
    end

    function DBNode_methods.delete(self)
        if self.parent then
            self.parent.children[self.name] = nil
        end
    end

    DBNode.__index = function(tbl, key)
        local method = DBNode_methods[key]
        if method then
            return function(...)
                local args = {...}
                if args[1] == tbl then
                    return method(unpack(args))
                else
                    return method(tbl, unpack(args))
                end
            end
        end
        return nil
    end

    DB = {}
    DB.root = DBNode.new("root", nil)

    function DB.getPathNode(nodeOrPath)
        if type(nodeOrPath) == "string" then
            return DB.root:getChild(nodeOrPath)
        else
            return nodeOrPath
        end
    end

    function DB.getValue(nodeOrPath, path, default)
        local node
        local subpath
        local def
        
        if select("#", nodeOrPath, path, default) == 2 or default == nil then
            node = DB.root
            subpath = nodeOrPath
            def = path
        else
            node = DB.getPathNode(nodeOrPath)
            subpath = path
            def = default
        end
        
        if not node then return def end
        
        if subpath and subpath ~= "" then
            node = node:getChild(subpath)
        end
        
        if not node or node:getValue() == nil then
            return def
        end
        return node:getValue()
    end

    function DB.setValue(nodeOrPath, path, typeStr, value)
        local node
        local subpath
        local valType
        local val
        
        if select("#", nodeOrPath, path, typeStr, value) == 3 or value == nil then
            node = DB.root
            subpath = nodeOrPath
            valType = path
            val = typeStr
        else
            node = DB.getPathNode(nodeOrPath)
            subpath = path
            valType = typeStr
            val = value
        end
        
        if not node then return end
        
        if not subpath or subpath == "" then
            node:setValue(val, valType)
        else
            local target = node:createChild(subpath)
            if target then
                target:setValue(val, valType)
            end
        end
    end
  `);

  return lua;
}

// Function to load a specific script into its own sandbox environment
async function loadScript(lua, scriptCode, scriptName, envName) {
  await lua.global.set('_temp_code', scriptCode);
  await lua.global.set('_temp_name', scriptName);
  await lua.doString(`
    ${envName} = setmetatable({}, { __index = _G })
    ${envName}.self = ${envName}
    local fn, err = load(_temp_code, _temp_name, "t", ${envName})
    if not fn then error(err) end
    fn()
  `);
}

async function runSuite() {
  console.log("Starting unit tests for Spell-Action-Info...");

  // Mocks setup
  const options = {};
  const optionCallbacks = {};
  const OptionsManager = {
    registerOption2: (key, bLocal, header, label, entry, config) => {
      options[key] = config.default || 'off';
    },
    registerCallback: (key, cb) => {
      if (!optionCallbacks[key]) optionCallbacks[key] = [];
      optionCallbacks[key].push(cb);
    },
    unregisterCallback: (key, cb) => {
      if (!optionCallbacks[key]) return;
      optionCallbacks[key] = optionCallbacks[key].filter(c => c !== cb);
    },
    isOption: (key, val) => {
      return options[key] === val;
    },
    // helper to set and trigger callbacks
    setOption: (key, val) => {
      options[key] = val;
      if (optionCallbacks[key]) {
        for (const cb of optionCallbacks[key]) {
          cb();
        }
      }
    }
  };

  const Interface = {
    getString: (id) => `STRING_${id}`
  };

  const ActorManager = {
    resolveActor: (node) => {
      return { node, isPC: true, name: "Test Hero" };
    },
    isPC: (actor) => {
      return actor && actor.isPC;
    }
  };

  const messages = [];
  const ChatManager = {
    Message: (text, bSenderPC, rActor) => {
      messages.push({ text, bSenderPC, rActor });
    }
  };

  const parses = [];
  const SpellManager = {
    parseSpell: (node) => {
      parses.push({ type: 'spell', node });
    }
  };
  const PowerManager = {
    parsePCPower: (node) => {
      parses.push({ type: 'power', node });
    }
  };

  // ----------------- TEST 1: Options Init -----------------
  await test("Options Init Registers SAIC Option", async () => {
    const lua = await createLuaEngine();
    lua.global.set('OptionsManager', OptionsManager);

    await loadScript(lua, saiOptionsInitLua, "sai_data_options_init.lua", "SAI_OptionsInit");
    await lua.doString("SAI_OptionsInit.onInit()");

    assertEquals(options["SAIC"], "off");
  });

  // ----------------- TEST 2: Visibility Components -----------------
  await test("Visibility Components Registers Callback on Init", async () => {
    const lua = await createLuaEngine();
    let callbackRegistered = false;
    
    const LocalOptionsManager = {
      registerCallback: (key, cb) => {
        if (key === "SAIC") callbackRegistered = true;
      },
      isOption: () => false
    };

    lua.global.set('OptionsManager', LocalOptionsManager);
    await loadScript(lua, visibilityComponentsLua, "visibility_components.lua", "VisibilityComponents");
    
    // Mock the window & setVisible
    await lua.doString(`
      VisibilityComponents.setVisible = function(b) VisibilityComponents.visible = b end
      VisibilityComponents.onInit()
    `);

    assert(callbackRegistered, "Callback should be registered for SAIC");
  });

  await test("Visibility Components StateChanged sets visibility and width", async () => {
    const lua = await createLuaEngine();
    let currentOptionVal = "off";

    const LocalOptionsManager = {
      registerCallback: () => {},
      isOption: (key, val) => key === "SAIC" && val === currentOptionVal
    };

    lua.global.set('OptionsManager', LocalOptionsManager);
    await loadScript(lua, visibilityComponentsLua, "visibility_components.lua", "VisibilityComponents");

    // Setup mocks on the script environment
    await lua.doString(`
      VisibilityComponents.visible = nil
      VisibilityComponents.width = nil
      VisibilityComponents.value = nil
      VisibilityComponents.setVisible = function(b) VisibilityComponents.visible = b end
      VisibilityComponents.setAnchoredWidth = function(w) VisibilityComponents.width = w end
      VisibilityComponents.setValue = function(v) VisibilityComponents.value = v end
      
      VisibilityComponents.dbNode = DB.root:createChild("spell")
      DB.setValue(VisibilityComponents.dbNode, "components", "string", "V, S, M (a pinch of dust)")
      
      VisibilityComponents.window = {
        getDatabaseNode = function() return VisibilityComponents.dbNode end
      }
    `);

    // Case 1: Option is OFF
    currentOptionVal = "off";
    await lua.doString("VisibilityComponents.StateChanged()");
    let visible = await lua.doString("return VisibilityComponents.visible");
    assertEquals(visible, false, "Should be invisible when option is off");

    // Case 2: Option is ON, LibraryData5E is NIL
    currentOptionVal = "on";
    await lua.doString("VisibilityComponents.StateChanged()");
    visible = await lua.doString("return VisibilityComponents.visible");
    let width = await lua.doString("return VisibilityComponents.width");
    let val = await lua.doString("return VisibilityComponents.value");
    
    assertEquals(visible, true, "Should be visible when option is on");
    assertEquals(width, 75, "Should have width 75 when LibraryData5E is not defined");
    assertEquals(val, "V,S,M", "Should strip spaces and parenthetical info");

    // Case 3: Option is ON, LibraryData5E is TRUE
    await lua.doString("LibraryData5E = {}");
    await lua.doString("VisibilityComponents.StateChanged()");
    width = await lua.doString("return VisibilityComponents.width");
    assertEquals(width, 50, "Should have width 50 when LibraryData5E is defined");
  });

  await test("Visibility Components setComponentsText edge cases", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, visibilityComponentsLua, "visibility_components.lua", "VisibilityComponents");
    
    await lua.doString(`
      VisibilityComponents.value = nil
      VisibilityComponents.setValue = function(v) VisibilityComponents.value = v end
      VisibilityComponents.dbNode = DB.root:createChild("spell")
      VisibilityComponents.window = {
        getDatabaseNode = function() return VisibilityComponents.dbNode end
      }
    `);

    const testCases = [
      { input: "V, S, M (holy symbol)", expected: "V,S,M" },
      { input: "Prerequisite: Level 5", expected: "" }, // contains digit, should result in empty
      { input: "3rd level prerequisite", expected: "" }, // contains digit, should result in empty
      { input: "V, S", expected: "V,S" },
      { input: "", expected: "" }
    ];

    for (const tc of testCases) {
      await lua.doString(`DB.setValue(VisibilityComponents.dbNode, "components", "string", [[${tc.input}]])`);
      await lua.doString("VisibilityComponents.setComponentsText()");
      const val = await lua.doString("return VisibilityComponents.value");
      assertEquals(val, tc.expected, `Input: "${tc.input}"`);
    }
  });

  // ----------------- TEST 3: Power Item -----------------
  await test("Power Item onInit with Auto-parsing", async () => {
    const lua = await createLuaEngine();
    lua.global.set('PowerManager', PowerManager);
    
    await loadScript(lua, powerItemLua, "power_item.lua", "PowerItem");

    // Setup mocks on the script environment
    await lua.doString(`
      local char = DB.root:createChild("charsheet"):createChild("id-00001")
      local powers = char:createChild("powers")
      local power = powers:createChild("id-00002")
      
      PowerItem.dbNode = power
      PowerItem.getDatabaseNode = function() return PowerItem.dbNode end
      
      PowerItem.super_onInit_called = false
      PowerItem.super = {
        onInit = function() PowerItem.super_onInit_called = true end,
        onDisplayChanged = function() end
      }

      PowerItem.onChildWindowAdded_called = false
      PowerItem.windowlist = {
        onChildWindowAdded = function(self) PowerItem.onChildWindowAdded_called = true end
      }

      PowerItem.header = {
        subwindow = {
          action_text_label = { setVisible = function() end },
          components_text_label = { setVisible = function() end }
        }
      }
    `);

    // Case 1: parse is 0 (should not call parsePCPower)
    parses.length = 0;
    await lua.doString("DB.setValue(PowerItem.dbNode, 'parse', 'number', 0)");
    await lua.doString("PowerItem.onInit()");
    assertEquals(parses.length, 0, "Should not auto-parse if parse option is 0");
    let superCalled = await lua.doString("return PowerItem.super_onInit_called");
    let childAddedCalled = await lua.doString("return PowerItem.onChildWindowAdded_called");
    assertEquals(superCalled, true, "Super onInit should be called");
    assertEquals(childAddedCalled, true, "windowlist.onChildWindowAdded should be called");

    // Case 2: parse is 1 (should call parsePCPower and reset parse to 0)
    parses.length = 0;
    await lua.doString("DB.setValue(PowerItem.dbNode, 'parse', 'number', 1)");
    await lua.doString("PowerItem.onInit()");
    assertEquals(parses.length, 1, "Should auto-parse if parse option is 1");
    assertEquals(parses[0].type, 'power');
    const parseVal = await lua.doString("return DB.getValue(PowerItem.dbNode, 'parse', 99)");
    assertEquals(parseVal, 0, "Parse flag in DB should be reset to 0");
  });

  await test("Power Item onDisplayChanged visibility toggles", async () => {
    const lua = await createLuaEngine();
    let currentOptionVal = "off";

    const LocalOptionsManager = {
      isOption: (key, val) => key === "SAIC" && val === currentOptionVal
    };

    lua.global.set('OptionsManager', LocalOptionsManager);
    await loadScript(lua, powerItemLua, "power_item.lua", "PowerItem");

    await lua.doString(`
      local char = DB.root:createChild("charsheet"):createChild("id-00001")
      local powers = char:createChild("powers")
      local power = powers:createChild("id-00002")
      
      PowerItem.dbNode = power
      PowerItem.getDatabaseNode = function() return PowerItem.dbNode end
      
      PowerItem.action_text_visible = nil
      PowerItem.components_text_visible = nil

      PowerItem.header = {
        subwindow = {
          action_text_label = { setVisible = function(b) PowerItem.action_text_visible = b end },
          components_text_label = { setVisible = function(b) PowerItem.components_text_visible = b end }
        }
      }
    `);

    // Case 1: displayMode is "summary"
    await lua.doString("DB.setValue(PowerItem.dbNode, '...powerdisplaymode', 'string', 'summary')");
    await lua.doString("PowerItem.onDisplayChanged()");
    let actionVis = await lua.doString("return PowerItem.action_text_visible");
    let compVis = await lua.doString("return PowerItem.components_text_visible");
    assertEquals(actionVis, false);
    assertEquals(compVis, false);

    // Case 2: displayMode is "action" and SAIC is "off"
    currentOptionVal = "off";
    await lua.doString("DB.setValue(PowerItem.dbNode, '...powerdisplaymode', 'string', 'action')");
    await lua.doString("PowerItem.action_text_visible = nil");
    await lua.doString("PowerItem.components_text_visible = nil");
    await lua.doString("PowerItem.onDisplayChanged()");
    actionVis = await lua.doString("return PowerItem.action_text_visible");
    compVis = await lua.doString("return PowerItem.components_text_visible");
    assertEquals(actionVis, true);
    assertEquals(compVis, null); // should not be touched or set to true

    // Case 3: displayMode is "action" and SAIC is "on"
    currentOptionVal = "on";
    await lua.doString("PowerItem.onDisplayChanged()");
    actionVis = await lua.doString("return PowerItem.action_text_visible");
    compVis = await lua.doString("return PowerItem.components_text_visible");
    assertEquals(actionVis, true);
    assertEquals(compVis, true);
  });

  // ----------------- TEST 4: Spell -----------------
  await test("Spell setFilter and getFilter", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString("Spell.setFilter(false)");
    let filter = await lua.doString("return Spell.getFilter()");
    assertEquals(filter, false);

    await lua.doString("Spell.setFilter(true)");
    filter = await lua.doString("return Spell.getFilter()");
    assertEquals(filter, true);
  });

  await test("Spell onInit registers menu items and auto-parses", async () => {
    const lua = await createLuaEngine();
    lua.global.set('Interface', Interface);
    lua.global.set('SpellManager', SpellManager);

    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.dbNode = DB.root:createChild("spell")
      Spell.getDatabaseNode = function() return Spell.dbNode end
      
      Spell.menuItems = {}
      Spell.registerMenuItem = function(...)
        table.insert(Spell.menuItems, {...})
      end
      
      Spell.readOnly = false
      Spell.windowlist = {
        isReadOnly = function() return Spell.readOnly end
      }
      
      Spell.onDisplayChanged = function() end
    `);

    // Case 1: not read only, parse is 0
    parses.length = 0;
    await lua.doString("DB.setValue(Spell.dbNode, 'parse', 'number', 0)");
    await lua.doString("Spell.onInit()");
    
    let menuCount = await lua.doString("return #Spell.menuItems");
    assertEquals(menuCount, 8, "Should register 8 menu items");
    assertEquals(parses.length, 0);

    // Case 2: read only, parse is 1
    parses.length = 0;
    await lua.doString("Spell.menuItems = {}");
    await lua.doString("Spell.readOnly = true");
    await lua.doString("DB.setValue(Spell.dbNode, 'parse', 'number', 1)");
    await lua.doString("Spell.onInit()");

    menuCount = await lua.doString("return #Spell.menuItems");
    assertEquals(menuCount, 0, "Should not register menu items when read-only");
    assertEquals(parses.length, 1, "Should trigger SpellManager.parseSpell");
  });

  await test("Spell update toggles idelete visibility", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.idelete_visible = nil
      Spell.idelete = {
        setVisibility = function(b) Spell.idelete_visible = b end
      }
    `);

    // Case 1: minisheet is true (returns early)
    await lua.doString("Spell.minisheet = true");
    await lua.doString("Spell.update(true)");
    let ideleteVis = await lua.doString("return Spell.idelete_visible");
    assertEquals(ideleteVis, null);

    // Case 2: minisheet is false, update(true)
    await lua.doString("Spell.minisheet = false");
    await lua.doString("Spell.update(true)");
    ideleteVis = await lua.doString("return Spell.idelete_visible");
    assertEquals(ideleteVis, true);

    // Case 3: minisheet is false, update(false)
    await lua.doString("Spell.update(false)");
    ideleteVis = await lua.doString("return Spell.idelete_visible");
    assertEquals(ideleteVis, false);
  });

  await test("Spell onDisplayChanged display modes and SAIC options", async () => {
    const lua = await createLuaEngine();
    let currentOptionVal = "off";

    const LocalOptionsManager = {
      isOption: (key, val) => key === "SAIC" && val === currentOptionVal
    };

    lua.global.set('OptionsManager', LocalOptionsManager);
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      local char = DB.root:createChild("charsheet"):createChild("id-00001")
      local spellset = char:createChild("spellset"):createChild("id-00002")
      local level1 = spellset:createChild("levels"):createChild("level1")
      local spell = level1:createChild("spells"):createChild("id-00003")
      
      Spell.dbNode = spell
      Spell.getDatabaseNode = function() return Spell.dbNode end
      Spell.minisheet = false
      
      Spell.shortdescription_visible = nil
      Spell.actionsmini_visible = nil
      Spell.action_text_visible = nil
      Spell.components_text_visible = nil
      
      Spell.header = {
        subwindow = {
          shortdescription = { setVisible = function(b) Spell.shortdescription_visible = b end },
          actionsmini = { setVisible = function(b) Spell.actionsmini_visible = b end },
          action_text_label = { setVisible = function(b) Spell.action_text_visible = b end },
          components_text_label = { setVisible = function(b) Spell.components_text_visible = b end }
        }
      }
    `);

    // Case 1: spelldisplaymode is "summary"
    await lua.doString("DB.setValue(Spell.dbNode, '.......spelldisplaymode', 'string', 'summary')");
    await lua.doString("Spell.onDisplayChanged()");
    assertEquals(await lua.doString("return Spell.shortdescription_visible"), true);
    assertEquals(await lua.doString("return Spell.actionsmini_visible"), false);
    assertEquals(await lua.doString("return Spell.action_text_visible"), false);
    assertEquals(await lua.doString("return Spell.components_text_visible"), false);

    // Case 2: spelldisplaymode is "action", SAIC is off
    currentOptionVal = "off";
    await lua.doString("DB.setValue(Spell.dbNode, '.......spelldisplaymode', 'string', 'action')");
    // reset visibility variables
    await lua.doString("Spell.shortdescription_visible = nil");
    await lua.doString("Spell.actionsmini_visible = nil");
    await lua.doString("Spell.action_text_visible = nil");
    await lua.doString("Spell.components_text_visible = nil");
    await lua.doString("Spell.onDisplayChanged()");
    assertEquals(await lua.doString("return Spell.shortdescription_visible"), false);
    assertEquals(await lua.doString("return Spell.actionsmini_visible"), true);
    assertEquals(await lua.doString("return Spell.action_text_visible"), true);
    assertEquals(await lua.doString("return Spell.components_text_visible"), null); // untouched

    // Case 3: spelldisplaymode is "action", SAIC is on
    currentOptionVal = "on";
    await lua.doString("Spell.onDisplayChanged()");
    assertEquals(await lua.doString("return Spell.components_text_visible"), true);
  });

  await test("Spell onHover sets rowshade frame on minisheet", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.frame = nil
      Spell.setFrame = function(f) Spell.frame = f end
    `);

    // Case 1: minisheet false -> should do nothing
    await lua.doString("Spell.minisheet = false");
    await lua.doString("Spell.onHover(true)");
    let frame = await lua.doString("return Spell.frame");
    assertEquals(frame, null);

    // Case 2: minisheet true, bOver true
    await lua.doString("Spell.minisheet = true");
    await lua.doString("Spell.onHover(true)");
    frame = await lua.doString("return Spell.frame");
    assertEquals(frame, "rowshade");

    // Case 3: minisheet true, bOver false
    await lua.doString("Spell.onHover(false)");
    frame = await lua.doString("return Spell.frame");
    assertEquals(frame, null);
  });

  await test("Spell createAction creates correct DB structure", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.dbNode = DB.root:createChild("spell")
      Spell.getDatabaseNode = function() return Spell.dbNode end
    `);

    await lua.doString("Spell.createAction('cast')");
    
    const typeVal = await lua.doString("return DB.getValue('spell.actions.id-00001.type')");
    assertEquals(typeVal, 'cast');
  });

  await test("Spell onMenuSelection triggers correct actions", async () => {
    const lua = await createLuaEngine();
    lua.global.set('SpellManager', SpellManager);

    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.dbNode = DB.root:createChild("spell")
      Spell.getDatabaseNode = function() return Spell.dbNode end
      
      Spell.activatedetail = {
        val = 0,
        setValue = function(v) Spell.activatedetail.val = v end,
        getValue = function() return Spell.activatedetail.val end
      }
    `);

    // Menu 6, 7: delete node
    let exists = await lua.doString("return DB.root:getChild('spell') ~= nil");
    assertEquals(exists, true);
    await lua.doString("Spell.onMenuSelection(6, 7)");
    exists = await lua.doString("return DB.root:getChild('spell') ~= nil");
    assertEquals(exists, false);

    // Recreate spell node
    await lua.doString("Spell.dbNode = DB.root:createChild('spell')");
    
    // Menu 4: parse spell
    parses.length = 0;
    await lua.doString("Spell.onMenuSelection(4)");
    assertEquals(parses.length, 1);
    assertEquals(parses[0].type, 'spell');
    let actDetail = await lua.doString("return Spell.activatedetail.val");
    assertEquals(actDetail, 1);

    // Menu 3, 2: create action cast
    await lua.doString("Spell.activatedetail.val = 0");
    await lua.doString("Spell.onMenuSelection(3, 2)");
    let typeVal = await lua.doString("return DB.getValue('spell.actions.id-00001.type')");
    assertEquals(typeVal, 'cast');
    assertEquals(await lua.doString("return Spell.activatedetail.val"), 1);

    // Menu 3, 3: create action damage
    await lua.doString("Spell.onMenuSelection(3, 3)");
    typeVal = await lua.doString("return DB.getValue('spell.actions.id-00002.type')");
    assertEquals(typeVal, 'damage');

    // Menu 3, 4: create action heal
    await lua.doString("Spell.onMenuSelection(3, 4)");
    typeVal = await lua.doString("return DB.getValue('spell.actions.id-00003.type')");
    assertEquals(typeVal, 'heal');

    // Menu 3, 5: create action effect
    await lua.doString("Spell.onMenuSelection(3, 5)");
    typeVal = await lua.doString("return DB.getValue('spell.actions.id-00004.type')");
    assertEquals(typeVal, 'effect');
  });

  await test("Spell getDescription formatting", async () => {
    const lua = await createLuaEngine();
    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.dbNode = DB.root:createChild("spell")
      Spell.getDatabaseNode = function() return Spell.dbNode end
    `);

    // Case 1: Name only
    await lua.doString("DB.setValue(Spell.dbNode, 'name', 'string', 'Fireball')");
    await lua.doString("DB.setValue(Spell.dbNode, 'shortdescription', 'string', '')");
    let desc = await lua.doString("return Spell.getDescription()");
    assertEquals(desc, "Fireball");

    // Case 2: Name and short description
    await lua.doString("DB.setValue(Spell.dbNode, 'shortdescription', 'string', 'Deals 8d6 fire damage')");
    desc = await lua.doString("return Spell.getDescription()");
    assertEquals(desc, "Fireball - Deals 8d6 fire damage");
  });

  await test("Spell activatePower triggers Chat Message", async () => {
    const lua = await createLuaEngine();
    lua.global.set('ActorManager', ActorManager);
    lua.global.set('ChatManager', ChatManager);

    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      Spell.dbNode = DB.root:createChild("charsheet"):createChild("id-00001"):createChild("spellset"):createChild("id-00002"):createChild("levels"):createChild("level1"):createChild("spells"):createChild("id-00003")
      Spell.getDatabaseNode = function() return Spell.dbNode end
    `);

    await lua.doString("DB.setValue(Spell.dbNode, 'name', 'string', 'Magic Missile')");
    await lua.doString("DB.setValue(Spell.dbNode, 'shortdescription', 'string', 'Shoots 3 missiles')");

    messages.length = 0;
    await lua.doString("Spell.activatePower()");

    assertEquals(messages.length, 1);
    assertEquals(messages[0].text, "Magic Missile - Shoots 3 missiles");
    assertEquals(messages[0].bSenderPC, true);
    assertEquals(messages[0].rActor.name, "Test Hero");
  });

  await test("Spell usePower points/slots casting logic", async () => {
    const lua = await createLuaEngine();
    lua.global.set('ActorManager', ActorManager);
    lua.global.set('ChatManager', ChatManager);

    await loadScript(lua, spellLua, "spell.lua", "Spell");

    await lua.doString(`
      local char = DB.root:createChild("charsheet"):createChild("id-00001")
      local spellset = char:createChild("spellset"):createChild("id-00002")
      local level1 = spellset:createChild("levels"):createChild("level1")
      local spell = level1:createChild("spells"):createChild("id-00003")

      Spell.dbNode = spell
      Spell.getDatabaseNode = function() return Spell.dbNode end
    `);

    // Case 1: Castertype is slots/empty (normal cast)
    await lua.doString("DB.setValue('charsheet.id-00001.spellset.id-00002', 'castertype', 'string', 'slots')");
    await lua.doString("DB.setValue(Spell.dbNode, 'name', 'string', 'Fireball')");
    
    messages.length = 0;
    await lua.doString("Spell.usePower()");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].text, "Fireball");

    // Case 2: Castertype is points, enough PP
    await lua.doString("DB.setValue('charsheet.id-00001.spellset.id-00002', 'castertype', 'string', 'points')");
    await lua.doString("DB.setValue('charsheet.id-00001.spellset.id-00002.points', 'number', 10)");
    await lua.doString("DB.setValue('charsheet.id-00001.spellset.id-00002.pointsused', 'number', 2)");
    await lua.doString("DB.setValue(Spell.dbNode, 'cost', 'number', 3)");
    await lua.doString("DB.setValue(Spell.dbNode, 'name', 'string', 'Mind Thrust')");

    messages.length = 0;
    await lua.doString("Spell.usePower()");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].text, "Mind Thrust [3 PP]");
    
    let pointsUsed = await lua.doString("return DB.getValue('charsheet.id-00001.spellset.id-00002.pointsused')");
    assertEquals(pointsUsed, 5, "Points used should be incremented by cost (2 + 3 = 5)");

    // Case 3: Castertype is points, insufficient PP
    // Available: 10, Used: 9. Need: 3. (10 - 9 = 1 available, less than 3)
    await lua.doString("DB.setValue('charsheet.id-00001.spellset.id-00002.pointsused', 'number', 9)");
    
    messages.length = 0;
    await lua.doString("Spell.usePower()");
    assertEquals(messages.length, 1);
    assertEquals(messages[0].text, "Mind Thrust [3 PP] [INSUFFICIENT PP AVAILABLE]");
    
    pointsUsed = await lua.doString("return DB.getValue('charsheet.id-00001.spellset.id-00002.pointsused')");
    assertEquals(pointsUsed, 9, "Points used should NOT be incremented");
  });

  // Print results
  console.log("\n----------------------------------------");
  console.log(`Unit Test Summary:`);
  console.log(`Total: ${testCount}`);
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log("----------------------------------------");

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("All tests passed successfully!");
    process.exit(0);
  }
}

runSuite().catch(err => {
  console.error("Unhandle rejection in test suite:", err);
  process.exit(1);
});
