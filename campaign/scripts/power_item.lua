-- 
-- Please see the license.html file included with this distribution for 
-- attribution and copyright information.
--

function onInit()
    if super and super.onInit then
        super.onInit();
    end

    --Check to see if we should automatically parse attack description
    local nodeAttack = getDatabaseNode();
    local nParse = DB.getValue(nodeAttack, "parse", 0);
    if nParse ~= 0 then
        DB.setValue(nodeAttack, "parse", "number", 0);
        PowerManager.parsePCPower(nodeAttack);
    end
    
    onDisplayChanged();
    windowlist.onChildWindowAdded(self);
end

function onDisplayChanged()
    if super and super.onDisplayChanged then
        super.onDisplayChanged();
    end

    local sDisplayMode = DB.getValue(getDatabaseNode(), "...powerdisplaymode", "");
    if sDisplayMode == "summary" then
        header.subwindow.action_text_label.setVisible(false);
        header.subwindow.components_text_label.setVisible(false);
    elseif sDisplayMode == "action" then
        header.subwindow.action_text_label.setVisible(true);
        if OptionsManager.isOption("SAIC", "on") then
            header.subwindow.components_text_label.setVisible(true);
        end
    else
        header.subwindow.action_text_label.setVisible(false);
        header.subwindow.components_text_label.setVisible(false);
    end
end