mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[lastTime];
xView = lastTime;

document.getElementById("totalPage").innerHTML = comicImagesLength;
document.getElementById("currentPage").innerHTML = xView+1;
window.addEventListener("contextmenu",(event_t)=>{
    event_t.preventDefault();
})

function rightTriggerArrow(event_t){
        event_t.preventDefault();
        xView++;
        xView = xView % comicImagesLength;
        mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[xView] ;
        TriggerLeftorRight();
}
function leftTriggerArrow(event_t){
        event_t.preventDefault();
        xView--;
        if(xView < 0){
            xView = 0
        }
        mainImage.src = "/public/uploads/"+comicFolder+"/"+comicImages[xView] ;
        TriggerLeftorRight();
}

function TriggerLeftorRight(){
    window.localStorage[comicFolder] = xView;
    document.getElementById("infoComic").style.visibility = "hidden";
    document.getElementById("rightTrigger").style.visibility = "visible";
    document.getElementById("leftTrigger").style.visibility = "visible";
    document.getElementById("currentPage").innerHTML = xView+1;
}

mainImage.addEventListener("mouseup",(event_t)=>{

    if(event_t.button == 0){
        rightTriggerArrow(event_t);
    }
    if(event_t.button == 2){
        leftTriggerArrow(event_t);
    }

})

document.getElementById("rightTrigger").addEventListener("mousedown",(event_t)=>{
    rightTriggerArrow(event_t);
})
document.getElementById("leftTrigger").addEventListener("mousedown",(event_t)=>{
    leftTriggerArrow(event_t);
})

document.addEventListener("keydown",(event_t)=>{
    // key space " " or ArrowRight ->
    if(event_t.key == " " || event_t.key == "ArrowRight"){
        rightTriggerArrow(event_t);
    }
    // key ArrowLeft <-
    if(event_t.key == "ArrowLeft"){
        leftTriggerArrow(event_t);
    }
})

document.getElementById("infoComic_details").addEventListener("mousedown",()=>{
    document.getElementById("infoComic").style.visibility = "visible";
    document.getElementById("rightTrigger").style.visibility = "hidden";
    document.getElementById("leftTrigger").style.visibility = "hidden";
});